/**
 * The in-page Game Boy: loads the player's own ROM (kept in this browser for
 * next time), shows the screen with keyboard, gamepad and touch controls, and
 * hands the page a link transport (SerialEmu) to play online with, the same
 * way a USB adapter with a real Game Boy would.
 */
import { GameBoyEmulator } from './GameBoyEmulator.js';
import { EmulatorInput } from './EmulatorInput.js';
import { GameStore, gameId } from './GameStore.js';
import { SerialEmu } from './SerialEmu.js';

const ROM_EXT = /\.(gb|gbc|sgb)$/i;
const MAX_ROM_SIZE = 8 * 1024 * 1024;

const svg = (body) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const SPEAKER = '<path d="M4 9h4l5-4v14l-5-4H4z"/>';
const ICONS = {
    soundOn: svg(`${SPEAKER}<path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11"/>`),
    soundOff: svg(`${SPEAKER}<path d="M17 9.5l5 5M22 9.5l-5 5"/>`),
    border: svg('<rect x="2.5" y="4" width="19" height="16" rx="2"/><rect x="7.5" y="8.5" width="9" height="7"/>'),
    enterFullscreen: svg('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>'),
    exitFullscreen: svg('<path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5"/>'),
    remove: svg('<path d="M4 7h16M10 7V4.5h4V7M6.5 7l1 13h9l1-13M10 11v5M14 11v5"/>'),
};

const TEMPLATE = `
<div class="gbemu-bar">
    <span class="gbemu-title"></span>
    <div class="gbemu-view" hidden>
        <button type="button" class="gbemu-icon" data-view="sound"></button>
        <button type="button" class="gbemu-icon" data-view="border" hidden></button>
        <button type="button" class="gbemu-icon" data-view="fullscreen"></button>
    </div>
</div>
<div class="gbemu-screen empty">
    <canvas width="160" height="144" aria-label="Game Boy screen"></canvas>
    <div class="gbemu-loader">
        <button type="button" class="gbemu-back" hidden></button>
        <p class="gbemu-loader-title"></p>
        <button type="button" class="gbemu-choose">Choose ROM</button>
        <p class="gbemu-hint"></p>
        <section class="gbemu-library" hidden aria-label="Games kept in this browser">
            <div class="gbemu-library-head">Kept in this browser</div>
            <ul class="gbemu-library-list"></ul>
        </section>
    </div>
</div>
<div class="gbemu-touch">
    <div class="gbemu-dpad">
        <span data-key="UP" class="up"></span>
        <span data-key="LEFT" class="left"></span>
        <span class="center"></span>
        <span data-key="RIGHT" class="right"></span>
        <span data-key="DOWN" class="down"></span>
    </div>
    <div class="gbemu-meta">
        <span data-key="SELECT">Select</span>
        <span data-key="START">Start</span>
    </div>
    <div class="gbemu-ab">
        <span data-key="B">B</span>
        <span data-key="A">A</span>
    </div>
</div>
<div class="gbemu-toolbar" hidden>
    <button type="button" data-action="reset">Reset</button>
    <button type="button" data-action="change">Change game</button>
    <button type="button" data-action="close">Close</button>
</div>
<p class="gbemu-keys">Keys: arrows, X or A = A, Z or S = B, Enter = Start, Shift = Select. Gamepads work too.</p>
<p class="gbemu-message" role="status" hidden></p>
<input type="file" accept=".gb,.gbc,.sgb" hidden>
`;

export class EmulatorPanel {
    /**
     * host: element the panel is built in.
     * options.game: { name, files (".gb" if left out), identify(rom) -> { title, model? }, { error } or null when it isn't this game }
     * options.emulatorUrl / workletUrl: where emulator/mgba-gb.* and audio-worklet.js are served
     * options.storeName: this site's IndexedDB name for kept games
     * options.buttonClass: the page's button classes
     * options.onStart(serial, info): a game is running (again) and ready to link
     * options.onClose(): the player closed the emulator
     */
    constructor(host, options) {
        this.host = host;
        this.options = options;
        this.game = null;
        this.emulator = null;
        this.serial = null;
        this.input = null;
        this.store = new GameStore(options.storeName);
        this.isOpen = false;
        this.isFullscreen = false;
        this._fullscreenApi = false;
        this._locked = false;
        this._kept = new Map();
        this._build();
    }

    get hasGame() {
        return !!(this.emulator && this.emulator.loaded && this.game);
    }

    _build() {
        const root = document.createElement('section');
        root.className = 'gbemu';
        root.hidden = true;
        root.setAttribute('aria-label', 'Game Boy emulator');
        root.innerHTML = TEMPLATE;
        this.host.appendChild(root);
        const q = (sel) => root.querySelector(sel);
        this.el = {
            root, title: q('.gbemu-title'), view: q('.gbemu-view'),
            btnSound: q('[data-view="sound"]'), btnBorder: q('[data-view="border"]'), btnFullscreen: q('[data-view="fullscreen"]'),
            screen: q('.gbemu-screen'), canvas: q('canvas'), loader: q('.gbemu-loader'), back: q('.gbemu-back'),
            loaderTitle: q('.gbemu-loader-title'), choose: q('.gbemu-choose'), hint: q('.gbemu-hint'),
            library: q('.gbemu-library'), libraryList: q('.gbemu-library-list'),
            touch: q('.gbemu-touch'), toolbar: q('.gbemu-toolbar'), keys: q('.gbemu-keys'), message: q('.gbemu-message'), file: q('input[type="file"]'),
        };
        const { name } = this.options.game;
        const buttonClass = this.options.buttonClass || '';
        for (const b of [this.el.choose, this.el.back, ...this.el.toolbar.querySelectorAll('button')]) b.className += ` ${buttonClass}`;
        this.el.title.textContent = name;
        this.el.loaderTitle.textContent = `Load your ${name} ROM`;
        this.el.hint.textContent = `The ${this.options.game.files || '.gb'} file of your ${name} cartridge. It stays on this device.`;
        this._bind();
    }

    _bind() {
        const el = this.el;
        el.choose.addEventListener('click', () => { this._wakeAudio(); el.file.click(); });
        el.file.addEventListener('change', () => {
            const file = el.file.files && el.file.files[0];
            el.file.value = '';
            if (file) this.loadFile(file);
        });
        el.back.addEventListener('click', () => { this._wakeAudio(); this._backToGame(); });
        el.libraryList.addEventListener('click', (e) => {
            const button = e.target.closest('button[data-action]');
            if (!button) return;
            this._wakeAudio();
            const id = button.closest('[data-id]').dataset.id;
            if (button.dataset.action === 'play') this._playKept(id);
            else if (button.dataset.action === 'remove') this._removeKept(id);
        });
        el.toolbar.addEventListener('click', (e) => {
            const action = e.target.closest('button[data-action]')?.dataset.action;
            if (action === 'reset') this.reset();
            else if (action === 'change') this._openLibrary();
            else if (action === 'close') this.close();
        });
        el.btnSound.addEventListener('click', () => this._toggleSound());
        el.btnBorder.addEventListener('click', () => this._toggleBorder());
        el.btnFullscreen.addEventListener('click', () => (this.isFullscreen ? this.exitFullscreen() : this.enterFullscreen()));
        const fullscreenChanged = () => {
            if (this.isFullscreen && this._fullscreenApi && !fullscreenElement()) this.exitFullscreen();
        };
        document.addEventListener('fullscreenchange', fullscreenChanged);
        document.addEventListener('webkitfullscreenchange', fullscreenChanged);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isFullscreen && !fullscreenElement()) this.exitFullscreen();
        });
        el.screen.addEventListener('dragover', (e) => e.preventDefault());
        el.screen.addEventListener('drop', (e) => {
            e.preventDefault();
            const file = e.dataTransfer?.files?.[0];
            if (file) this.loadFile(file);
        });
    }

    /** Shows the panel with the ROM chooser (or the running game). */
    async open() {
        if (!this.emulator) {
            this.emulator = await GameBoyEmulator.create(this.options.emulatorUrl);
            this.emulator.onResize = (w, h) => this.el.screen.style.setProperty('--gbemu-ar', `${w} / ${h}`);
            this.emulator.onSaveChange = (save) => { if (this.game) this.store.updateSave(this.game.id, save); };
            this.serial = new SerialEmu(this.emulator);
        }
        this.isOpen = true;
        this.el.root.hidden = false;
        document.body.classList.add('gbemu-active');
        this.emulator.setVolume(this._soundOn() ? 1 : 0);
        this.emulator.setSgbBorder(this._borderOn());
        this._renderView();
        if (!this.input) {
            this.input = new EmulatorInput(this.emulator, {
                isActive: () => this.isOpen && this.hasGame && !this.el.toolbar.hidden,
                touchArea: this.el.touch,
                onGesture: () => this._wakeAudio(),
            });
            this.input.attach();
        }
        this._wakeAudio();
        if (!this.hasGame) {
            this._showLoader(true);
            await this._renderLibrary();
        }
    }

    /** Stops the game and hides the panel. */
    close() {
        this.exitFullscreen();
        if (this.hasGame) this.emulator.checkSave();
        this.isOpen = false;
        if (this.input) this.input.detach();
        this.input = null;
        if (this.emulator) this.emulator.unload();
        if (this.serial) this.serial.close();
        this.serial = this.emulator ? new SerialEmu(this.emulator) : null;
        this.game = null;
        this._message('');
        this.el.root.hidden = true;
        document.body.classList.remove('gbemu-active');
        if (this.options.onClose) this.options.onClose();
    }

    /** No cartridge swaps or resets while a match is running. */
    setLocked(locked) {
        this._locked = locked;
        for (const b of this.el.toolbar.querySelectorAll('button')) b.disabled = locked;
    }

    _wakeAudio() {
        const url = new URL(this.options.workletUrl, document.baseURI).href;
        if (this.emulator) this.emulator.enableAudio(url).catch(() => {});
    }

    _soundOn() {
        try { return localStorage.getItem('gblink.emuSound') !== '0'; } catch (_) { return true; }
    }

    _toggleSound() {
        const on = !this._soundOn();
        try { localStorage.setItem('gblink.emuSound', on ? '1' : '0'); } catch (_) {}
        this.emulator.setVolume(on ? 1 : 0);
        if (on) this._wakeAudio();
        this._renderView();
    }

    _borderOn() {
        try { return localStorage.getItem('gblink.emuBorder') === '1'; } catch (_) { return false; }
    }

    _toggleBorder() {
        const on = !this._borderOn();
        try { localStorage.setItem('gblink.emuBorder', on ? '1' : '0'); } catch (_) {}
        this.emulator.setSgbBorder(on);
        this._renderView();
    }

    _renderView() {
        const sound = this._soundOn(), border = this._borderOn(), full = this.isFullscreen;
        renderIcon(this.el.btnSound, sound ? ICONS.soundOn : ICONS.soundOff, 'Sound', sound, sound ? 'Sound: on' : 'Sound: off');
        renderIcon(this.el.btnBorder, ICONS.border, 'Super Game Boy border', border, border ? 'Super Game Boy border: on' : 'Super Game Boy border: off');
        this.el.btnBorder.hidden = !this.hasGame || !this.emulator.hasBorder;
        const label = full ? 'Exit fullscreen' : 'Fullscreen';
        renderIcon(this.el.btnFullscreen, full ? ICONS.exitFullscreen : ICONS.enterFullscreen, label, null, label);
    }

    /** The page goes fullscreen with only the game showing; phones without the Fullscreen API get the same layout filling the window. */
    enterFullscreen() {
        if (this.isFullscreen || !this.hasGame) return;
        this.isFullscreen = true;
        document.body.classList.add('gbemu-fullscreen');
        this._renderView();
        const root = document.documentElement;
        const request = root.requestFullscreen || root.webkitRequestFullscreen;
        this._fullscreenApi = false;
        if (!request) return;
        try {
            const result = request.call(root);
            this._fullscreenApi = true;
            if (result && result.catch) result.catch(() => { this._fullscreenApi = false; });
        } catch (_) {
            this._fullscreenApi = false;
        }
    }

    exitFullscreen() {
        if (!this.isFullscreen) return;
        this.isFullscreen = false;
        this._fullscreenApi = false;
        document.body.classList.remove('gbemu-fullscreen');
        this._renderView();
        if (fullscreenElement()) {
            const exit = document.exitFullscreen || document.webkitExitFullscreen;
            try {
                const result = exit.call(document);
                if (result && result.catch) result.catch(() => {});
            } catch (_) {}
        }
    }

    _showLoader(show) {
        if (show) this.exitFullscreen();
        const el = this.el;
        el.loader.hidden = !show;
        el.toolbar.hidden = show;
        el.view.hidden = show;
        el.keys.hidden = show;
        el.screen.classList.toggle('empty', show);
        el.back.hidden = !(show && this.hasGame);
        if (show && this.hasGame) el.back.textContent = `Back to ${this.game.title}`;
        el.title.textContent = !show && this.game ? this.game.title : this.options.game.name;
    }

    _message(text, type = 'info') {
        this.el.message.textContent = text;
        this.el.message.dataset.type = type;
        this.el.message.hidden = !text;
    }

    async _openLibrary() {
        if (!this.hasGame || this._locked) return;
        this.emulator.stop();
        this.emulator.checkSave();
        await this._renderLibrary();
        this._showLoader(true);
    }

    _backToGame() {
        if (!this.hasGame) return;
        this._showLoader(false);
        this.emulator.start();
    }

    async _renderLibrary() {
        const games = await this.store.list();
        this._kept = new Map(games.map((g) => [g.id, g]));
        this.el.library.hidden = games.length === 0;
        this.el.screen.classList.toggle('has-library', games.length > 0);
        this.el.libraryList.replaceChildren(...games.map((g) => this._libraryRow(g)));
    }

    _libraryRow(game) {
        const running = this.hasGame && this.game.id === game.id;
        const row = document.createElement('li');
        row.className = 'gbemu-game';
        row.dataset.id = game.id;
        const play = document.createElement('button');
        play.type = 'button';
        play.className = 'gbemu-game-play';
        play.dataset.action = 'play';
        play.title = running ? 'Back to the game' : `Play ${game.title}`;
        const name = document.createElement('span');
        name.className = 'gbemu-game-title';
        name.textContent = game.title;
        const meta = document.createElement('span');
        meta.className = 'gbemu-game-meta';
        meta.textContent = `${game.name} · ${running ? 'playing now' : `played ${formatWhen(game.playedAt)}`}`;
        play.append(name, meta);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'gbemu-icon';
        remove.dataset.action = 'remove';
        remove.innerHTML = ICONS.remove;
        remove.title = 'Remove from this browser';
        remove.setAttribute('aria-label', `Remove ${game.title} from this browser`);
        remove.hidden = running;
        row.append(play, remove);
        return row;
    }

    async _playKept(id) {
        if (this.hasGame && this.game.id === id) {
            this._backToGame();
            return;
        }
        const game = await this.store.get(id);
        if (!game) {
            await this._renderLibrary();
            return;
        }
        this._start({ id, name: game.name, rom: game.rom, save: game.save });
    }

    async _removeKept(id) {
        const game = this._kept.get(id);
        if (!game || (this.hasGame && this.game.id === id)) return;
        await this.store.remove(id);
        await this._renderLibrary();
    }

    /** Starts a ROM file the player chose. */
    async loadFile(file) {
        if (file.size > MAX_ROM_SIZE || file.size < 0x150) {
            this._message('That file isn\'t a Game Boy ROM.', 'error');
            return;
        }
        const rom = new Uint8Array(await file.arrayBuffer());
        const id = gameId(rom);
        const kept = await this.store.get(id);
        this._start({ id, name: file.name.replace(ROM_EXT, ''), rom, save: kept ? kept.save : null });
    }

    _start({ id, name, rom, save }) {
        const info = this.options.game.identify(rom);
        if (!info || info.error) {
            this._message(info?.error ?? `That isn't a ${this.options.game.name} ROM. Choose the .gb file of your ${this.options.game.name} cartridge.`, 'error');
            return;
        }
        const emu = this.emulator;
        if (this.hasGame) emu.checkSave();
        emu.stop();
        if (!emu.load(rom, save, { model: info.model })) {
            this.game = null;
            this._showLoader(true);
            this._message('The emulator could not start this ROM.', 'error');
            return;
        }
        this.game = { id, name, rom, title: info.title, info };
        this._message('');
        emu.attachCanvas(this.el.canvas);
        emu.start();
        this._showLoader(false);
        this._renderView();
        this.store.put({ id, name, title: info.title, rom, save: emu.getSave() });
        if (this.options.onStart) this.options.onStart(this.serial, info);
    }

    /** Power-cycles the game, like switching the Game Boy off and on. */
    reset() {
        if (!this.hasGame || this._locked) return;
        this.emulator.reset();
        if (this.options.onStart) this.options.onStart(this.serial, this.game.info);
    }
}

function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function renderIcon(button, icon, label, pressed, title) {
    button.innerHTML = icon;
    button.title = title;
    button.setAttribute('aria-label', label);
    if (pressed === null) button.removeAttribute('aria-pressed');
    else button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
}

function formatWhen(time) {
    const date = new Date(time);
    const year = date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric';
    return date.toLocaleString([], { year, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
