/**
 * The emulator's games kept in this browser's IndexedDB: each ROM with its
 * battery save, so they can be played again without choosing the file. Nothing
 * leaves the device. Every call fails soft: private windows and blocked
 * storage just keep nothing.
 */
const DB_VERSION = 1;
// id -> { id, name, title, romSize, save, addedAt, playedAt }
const GAMES = 'games';
// id -> ROM bytes (kept apart so listing the games doesn't read the ROMs)
const ROMS = 'roms';

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
        t[i] = c >>> 0;
    }
    return t;
})();

/** The id a ROM is kept under: its CRC-32. */
export function gameId(rom) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < rom.length; i++) c = CRC_TABLE[(c ^ rom[i]) & 0xFF] ^ (c >>> 8);
    return ((c ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0');
}

export class GameStore {
    constructor(dbName) {
        this.dbName = dbName;
    }

    _open() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.dbName, DB_VERSION);
            req.onupgradeneeded = () => {
                req.result.createObjectStore(GAMES, { keyPath: 'id' });
                req.result.createObjectStore(ROMS);
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async _run(stores, mode, fn) {
        const db = await this._open();
        try {
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(stores, mode);
                let result;
                fn(tx, (value) => { result = value; });
                tx.oncomplete = () => resolve(result);
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error);
            });
        } finally {
            db.close();
        }
    }

    /** The kept games without their ROMs, last played first. */
    async list() {
        try {
            const games = await this._run([GAMES], 'readonly', (tx, done) => {
                tx.objectStore(GAMES).getAll().onsuccess = (e) => done(e.target.result);
            });
            return (games ?? []).sort((a, b) => b.playedAt - a.playedAt);
        } catch (_) {
            return [];
        }
    }

    /** One kept game with its ROM, or null. */
    async get(id) {
        try {
            return await this._run([GAMES, ROMS], 'readonly', (tx, done) => {
                tx.objectStore(GAMES).get(id).onsuccess = (e) => {
                    const game = e.target.result;
                    if (!game) return;
                    tx.objectStore(ROMS).get(id).onsuccess = (r) => done(r.target.result ? { ...game, rom: new Uint8Array(r.target.result) } : null);
                };
            }) ?? null;
        } catch (_) {
            return null;
        }
    }

    /** Keeps a game that was just started (its ROM is stored once). */
    async put({ id, name, title, rom, save }) {
        try {
            const now = Date.now();
            await this._run([GAMES, ROMS], 'readwrite', (tx) => {
                const games = tx.objectStore(GAMES);
                games.get(id).onsuccess = (e) => {
                    const old = e.target.result;
                    if (!old) tx.objectStore(ROMS).put(rom.buffer.slice(rom.byteOffset, rom.byteOffset + rom.byteLength), id);
                    games.put({ id, name, title, romSize: rom.length, save, addedAt: old?.addedAt ?? now, playedAt: now });
                };
            });
            return true;
        } catch (_) {
            return false;
        }
    }

    async updateSave(id, save) {
        try {
            await this._run([GAMES], 'readwrite', (tx) => {
                const games = tx.objectStore(GAMES);
                games.get(id).onsuccess = (e) => {
                    const game = e.target.result;
                    if (!game) return;
                    game.save = save;
                    games.put(game);
                };
            });
            return true;
        } catch (_) {
            return false;
        }
    }

    async remove(id) {
        try {
            await this._run([GAMES, ROMS], 'readwrite', (tx) => {
                tx.objectStore(GAMES).delete(id);
                tx.objectStore(ROMS).delete(id);
            });
            return true;
        } catch (_) {
            return false;
        }
    }
}
