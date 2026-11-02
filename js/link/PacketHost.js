/**
 * Shared base of the Tetris Attack and Tetris Plus link hosts (AttackHost.js,
 * PlusHost.js). Both games use Tetris DX's link code, where the clock
 * alternates between the two Game Boys, so the host works the emulator's link
 * port directly. On the title the game waits as follower with 0xDD; player 1
 * clocks 0xFE to link.
 *
 * attach(port) returns the emulator's link partner for its linkPort(): step()
 * runs after every slice of emulation, frame() once a frame.
 */
export class PacketHost {
    /** send(msg): sends to the other page. onEvent(name, data): see the subclasses. */
    constructor({ send, leader = false, onEvent = () => {} }) {
        this.send = send;
        this.onEvent = onEvent;
        this.leader = leader;
        this.port = null;
        this.clearRemote();
        this._phase('link');
    }

    attach(port) {
        this.port = port;
        this._unlink();
        return { step: () => this.step(), frame: () => this.frame() };
    }

    _phase(phase) {
        this.phase = phase;
        this.onEvent('phase', phase);
    }
}
