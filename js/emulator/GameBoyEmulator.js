/**
 * Game Boy emulator (mGBA's GB core compiled to WebAssembly, emulator/mgba-gb.*)
 * running in the page: screen, sound, keys, battery save and the link port.
 *
 * The game runs by cycle count, in step with real time: paced by the sound
 * output when sound is running (the audio thread keeps going in background
 * tabs), otherwise by the clock. The link port is driven as clock master, the
 * way the GB-Link adapter drives a cartridge: a byte is shifted the moment it
 * is sent, at the game's current point in time.
 */

export const GB_KEYS = { A: 1, B: 2, SELECT: 4, START: 8, RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128 };

// mGBA keeps Game Boy time in units of 2^23 a second (two per clock tick)
const CYCLES_PER_SECOND = 8388608;
const FRAME_CYCLES = 140448;
// The most the game runs at once; a longer stall is skipped, not caught up
const MAX_CATCH_UP_CYCLES = 6 * FRAME_CYCLES;
// Without sound the game runs this far ahead of the clock
const CLOCK_LEAD_CYCLES = FRAME_CYCLES;
// With sound, this much is queued for playback
const AUDIO_LEAD_SECONDS = 0.07;
// A byte sent while the game isn't waiting for one waits this long for it
const LINK_WAIT_CYCLES = 8389;
// With a link partner (see setLinkPartner) the game runs in slices this short
const PARTNER_SLICE_CYCLES = 2048;
const LINK_NOT_READY = 0x100;
const SAVE_CHECK_FRAMES = 60;

export class GameBoyEmulator {
    /** baseUrl: where mgba-gb.js and mgba-gb.wasm are served. */
    static async create(baseUrl) {
        const base = new URL(baseUrl, document.baseURI);
        const { default: createGbEmu } = await import(/* @vite-ignore */ new URL('mgba-gb.js', base).href);
        return new GameBoyEmulator(await createGbEmu({ locateFile: (path) => new URL(path, base).href }));
    }

    constructor(module) {
        this.m = module;
        this.loaded = false;
        this.running = false;
        this.onSaveChange = null;
        this.onFrame = null;
        this.onResize = null;
        this._keySources = new Map();
        this._lastSave = null;
        this._canvas = null;
        this._ctx = null;
        this._image = null;
        this._drawnFrame = -1;
        this._reportedFrame = 0;
        this._savedAtFrame = 0;
        this._audioPaced = false;
        this._rafId = null;
        this._timerId = null;
        this._clockStart = 0;
        this._clockCycles = 0;
        this._audio = null;
        this._volume = 1;
        this._onVisibility = () => this._schedule();
        this.linkWaitCycles = LINK_WAIT_CYCLES;
        this._partner = null;
        this._partnerFrame = 0;
    }

    /**
     * Loads a ROM (and battery save). Returns false when the core rejects it.
     * sgb: games that also run on a Game Boy Color start as on a Super Game Boy.
     */
    load(rom, save = null, { sgb = false } = {}) {
        const m = this.m;
        m._emu_set_prefer_sgb(sgb ? 1 : 0);
        const romPtr = m._emu_alloc(rom.length);
        m.HEAPU8.set(rom, romPtr);
        let savePtr = 0;
        if (save && save.length) {
            savePtr = m._emu_alloc(save.length);
            m.HEAPU8.set(save, savePtr);
        }
        const rc = m._emu_load(romPtr, rom.length, savePtr, save ? save.length : 0);
        if (savePtr) m._emu_free(savePtr);
        this.loaded = rc === 0;
        this._drawnFrame = -1;
        this._reportedFrame = 0;
        this._savedAtFrame = 0;
        if (this._audio) m._emu_set_sample_rate(this._audio.ctx.sampleRate);
        this._applyKeys();
        this._lastSave = this.loaded ? this.getSave() : null;
        return this.loaded;
    }

    unload() {
        this.stop();
        this.m._emu_unload();
        this.loaded = false;
    }

    /** Power-cycles the game; the battery save is kept. */
    reset() {
        if (this.loaded) this.m._emu_reset();
    }

    /** Frames the game has finished since it was loaded. */
    get frames() {
        return this.loaded ? this.m._emu_frames() : 0;
    }

    /** True when the running game is in Super Game Boy mode (its colors, and a border if enabled). */
    get isSgb() {
        return this.loaded && this.m._emu_is_sgb() === 1;
    }

    /** True when the game has a Super Game Boy border. */
    get hasBorder() {
        return this.loaded && this.m._emu_has_border() === 1;
    }

    /** Draws the game's Super Game Boy border around the screen (256x224 instead of 160x144). */
    setSgbBorder(on) {
        this.m._emu_set_sgb_border(on ? 1 : 0);
        this._drawnFrame = -1;
        this._draw();
    }

    getSave() {
        const m = this.m;
        const size = m._emu_save_size();
        if (size <= 0) return new Uint8Array(0);
        const ptr = m._emu_save_data();
        return m.HEAPU8.slice(ptr, ptr + size);
    }

    read8(address) {
        return this.m._emu_read8(address);
    }

    /** Keys from one input source (keyboard, gamepad, touch...); all sources are OR'ed. */
    setKeys(source, mask) {
        if (mask) this._keySources.set(source, mask);
        else this._keySources.delete(source);
        this._applyKeys();
    }

    _applyKeys() {
        let mask = 0;
        for (const v of this._keySources.values()) mask |= v;
        // Opposite directions at once confuse some games
        if ((mask & (GB_KEYS.LEFT | GB_KEYS.RIGHT)) === (GB_KEYS.LEFT | GB_KEYS.RIGHT)) mask &= ~(GB_KEYS.LEFT | GB_KEYS.RIGHT);
        if ((mask & (GB_KEYS.UP | GB_KEYS.DOWN)) === (GB_KEYS.UP | GB_KEYS.DOWN)) mask &= ~(GB_KEYS.UP | GB_KEYS.DOWN);
        if (this.loaded) this.m._emu_set_keys(mask);
    }

    /**
     * One clock-master transfer at the game's current point in time. Returns the
     * byte the game shifted out, or null when the game was not waiting for one
     * (the byte is then lost, as on the hardware).
     */
    exchange(byte) {
        if (!this.loaded || !this.running) return null;
        this.advance();
        const m = this.m;
        const result = m._emu_exchange(byte & 0xFF, this.linkWaitCycles);
        this._ran(m._emu_exchange_cycles());
        return result === LINK_NOT_READY ? null : result;
    }

    /** Runs the game for the given number of cycles (between exchanges, as the adapter waits). */
    wait(cycles) {
        if (this.loaded && this.running) this._ran(this.m._emu_run(cycles));
    }

    /**
     * A link partner that runs in step with the game, for link protocols where
     * the game drives the clock too: partner.step() is called after every short
     * slice of play and partner.frame() once a frame, and may use linkPort().
     * null removes it.
     */
    setLinkPartner(partner) {
        this._partner = partner;
        this._partnerFrame = this.frames;
        if (!partner && this.loaded) this.m._emu_set_link_follower(-1);
    }

    /** What a link partner works the link port with, at the game's current point in time. */
    linkPort() {
        const m = this.m;
        return {
            // Clock a byte into the game (waiting a little for it to listen); its byte, or null
            exchange: (byte, waitCycles = 3 * 8192) => {
                const result = m._emu_exchange(byte & 0xFF, waitCycles);
                this._ran(m._emu_exchange_cycles());
                return result === LINK_NOT_READY ? null : result;
            },
            // The byte the game receives when it drives the clock itself
            setFollower: (byte) => m._emu_set_link_follower(byte),
            // The bytes the game sent driving the clock itself since the last call
            takeMaster: () => {
                const out = [];
                for (let v; (v = m._emu_link_master()) >= 0;) out.push(v & 0xFF);
                return out;
            },
            press: (mask) => this.setKeys('link', mask),
        };
    }

    // ==================== Clock ====================

    start() {
        if (this.running || !this.loaded) return;
        this.running = true;
        this._resetClock();
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this._onVisibility);
        this._schedule();
    }

    stop() {
        this.running = false;
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this._onVisibility);
        if (this._rafId !== null) cancelAnimationFrame(this._rafId);
        if (this._timerId !== null) clearTimeout(this._timerId);
        this._rafId = null;
        this._timerId = null;
    }

    _resetClock() {
        this._clockStart = performance.now();
        this._clockCycles = 0;
        if (this._audio) {
            this._audio.pushed = this._audio.taken;
            this._audio.takenAt = performance.now();
        }
    }

    _audioClock() {
        return !!(this._audio && this._audio.ready && this._audio.ctx.state === 'running');
    }

    /** Cycles the game should have run by now that it hasn't yet. */
    _due() {
        const now = performance.now();
        if (this._audioClock()) {
            const a = this._audio;
            const rate = a.ctx.sampleRate;
            // Played since the worklet's last report, estimated from the clock
            const taken = a.taken + Math.min((now - a.takenAt) / 1000, 0.02) * rate;
            return ((taken + AUDIO_LEAD_SECONDS * rate - a.pushed) * CYCLES_PER_SECOND) / rate;
        }
        return ((now - this._clockStart) * CYCLES_PER_SECOND) / 1000 + CLOCK_LEAD_CYCLES - this._clockCycles;
    }

    /** Runs the game up to the present. */
    advance() {
        if (!this.running) return;
        const audioPaced = this._audioClock();
        if (audioPaced !== this._audioPaced) {
            this._audioPaced = audioPaced;
            this._resetClock();
        }
        let due = Math.floor(this._due());
        if (due <= 0) return;
        if (due > MAX_CATCH_UP_CYCLES) {
            due = FRAME_CYCLES;
            this._resetClock();
        }
        while (due > 0 && this.running) {
            const ran = this.m._emu_run(Math.min(due, this._partner ? PARTNER_SLICE_CYCLES : FRAME_CYCLES));
            this._ran(ran);
            due -= ran;
            if (this._partner) this._runPartner();
        }
    }

    _runPartner() {
        const partner = this._partner;
        partner.step();
        const frames = this.m._emu_frames();
        if (frames !== this._partnerFrame) {
            this._partnerFrame = frames;
            partner.frame();
        }
    }

    _ran(cycles) {
        if (cycles <= 0) return;
        this._clockCycles += cycles;
        const m = this.m;
        const samples = m._emu_audio();
        if (samples > 0 && this._audioPaced) this._pushAudio(m._emu_audio_buffer() >> 1, samples);
        const frames = m._emu_frames();
        if (frames - this._savedAtFrame >= SAVE_CHECK_FRAMES) {
            this._savedAtFrame = frames;
            this.checkSave();
        }
        if (frames !== this._reportedFrame) {
            this._reportedFrame = frames;
            if (this.onFrame) this.onFrame(frames);
        }
    }

    /** Reports a changed battery save to onSaveChange now (it is also checked every second). */
    checkSave() {
        if (!this.onSaveChange || !this.loaded) return;
        const save = this.getSave();
        const last = this._lastSave;
        if (last && last.length === save.length && last.every((v, i) => v === save[i])) return;
        this._lastSave = save;
        this.onSaveChange(save);
    }

    _schedule() {
        if (!this.running) return;
        const hidden = typeof document !== 'undefined' && document.hidden;
        if (typeof requestAnimationFrame === 'function' && !hidden) {
            if (this._rafId === null) this._rafId = requestAnimationFrame(() => { this._rafId = null; this._tick(); });
        } else if (this._timerId === null) {
            this._timerId = setTimeout(() => { this._timerId = null; this._tick(); }, 16);
        }
    }

    _tick() {
        if (!this.running) return;
        if (!this._audioClock()) this.advance();
        this._draw();
        this._schedule();
    }

    // ==================== Screen ====================

    attachCanvas(canvas) {
        this._canvas = canvas;
        this._ctx = canvas ? canvas.getContext('2d') : null;
        this._image = null;
        this._drawnFrame = -1;
        this._draw();
    }

    _draw() {
        if (!this._ctx || !this.loaded) return;
        const m = this.m;
        const frame = m._emu_frames();
        if (frame === this._drawnFrame) return;
        this._drawnFrame = frame;
        const w = m._emu_video_width(), h = m._emu_video_height(), stride = m._emu_video_stride();
        if (this._canvas.width !== w || this._canvas.height !== h) {
            this._canvas.width = w;
            this._canvas.height = h;
            this._image = null;
            if (this.onResize) this.onResize(w, h);
        }
        if (!this._image) this._image = this._ctx.createImageData(w, h);
        const src = m.HEAPU8;
        const base = m._emu_video();
        const dst = this._image.data;
        for (let y = 0; y < h; y++) {
            const row = base + y * stride * 4;
            dst.set(src.subarray(row, row + w * 4), y * w * 4);
        }
        this._ctx.putImageData(this._image, 0, 0);
    }

    // ==================== Sound ====================

    /** Starts sound output; call from a user gesture. The game then follows the sound clock. */
    async enableAudio(workletUrl) {
        if (this._audio || typeof AudioContext === 'undefined') {
            if (this._audio && this._audio.ctx.state !== 'running') await this._audio.ctx.resume().catch(() => {});
            return;
        }
        const ctx = new AudioContext({ latencyHint: 'interactive' });
        const gain = ctx.createGain();
        gain.gain.value = this._volume;
        gain.connect(ctx.destination);
        this._audio = { ctx, gain, node: null, ready: false, pushed: 0, taken: 0, takenAt: performance.now(), scratch: new Float32Array(8192) };
        this.m._emu_set_sample_rate(ctx.sampleRate);
        try {
            await ctx.audioWorklet.addModule(workletUrl);
            const node = new AudioWorkletNode(ctx, 'gb-audio', { outputChannelCount: [2] });
            node.port.onmessage = (e) => this._onAudioTaken(e.data);
            node.connect(gain);
            this._audio.node = node;
            this._audio.ready = true;
        } catch (e) {
            console.warn('Emulator sound unavailable:', e);
        }
        if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    }

    setVolume(volume) {
        this._volume = volume;
        if (this._audio) this._audio.gain.gain.value = volume;
    }

    _onAudioTaken(taken) {
        const a = this._audio;
        a.taken = Math.max(a.taken, taken);
        a.takenAt = performance.now();
        if (this.running && this._audioClock()) this.advance();
    }

    _pushAudio(offset, samples) {
        const a = this._audio;
        if (!a.ready) return;
        const n = samples * 2;
        const out = n <= a.scratch.length ? a.scratch.subarray(0, n) : new Float32Array(n);
        const src = this.m.HEAP16;
        for (let i = 0; i < n; i++) out[i] = src[offset + i] / 32768;
        a.node.port.postMessage(out.slice());
        a.pushed += samples;
    }

    destroy() {
        this.unload();
        if (this._audio) {
            this._audio.ctx.close().catch(() => {});
            this._audio = null;
        }
        this.attachCanvas(null);
    }
}
