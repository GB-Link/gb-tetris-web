/**
 * Shared base of the Tetris Attack and Tetris Plus link hosts (AttackHost.js,
 * PlusHost.js). Both games use Tetris DX's link code, where the clock
 * alternates between the two Game Boys. On the title the game waits as
 * follower with 0xDD; player 1 clocks 0xFE to link.
 *
 * In the emulator, attach(port) returns the emulator's link partner for its
 * linkPort(): step() runs after every slice of emulation, frame() once a frame.
 * On the adapter, useAdapter(adapter) takes a HybridAdapter (HybridAdapter.js),
 * linked with the game already or not, and tick() runs once a page frame.
 */
export class PacketHost {
    /** send(msg): sends to the other page. onEvent(name, data): see the subclasses. */
    constructor({ send, leader = false, onEvent = () => {} }) {
        this.send = send;
        this.onEvent = onEvent;
        this.leader = leader;
        this.link = null;
        this.clearRemote();
        this._phase('link');
    }

    attach(port) {
        this._useLink(this._portLink(port));
        this._unlink();
        return { step: () => this.step(), frame: () => this.frame() };
    }

    useAdapter(adapter) {
        this._useLink(this._adapterLink(adapter));
    }

    tick() {
        this.frame();
    }

    _phase(phase) {
        this.phase = phase;
        this.onEvent('phase', phase);
    }
}
