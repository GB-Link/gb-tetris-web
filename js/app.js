/**
 * GB Tetris Web Application
 * Converted from React to vanilla JavaScript
 */

class OnlineTetris {
    // Music codes
    SONG_A = "1C";
    SONG_B = "1D";
    SONG_C = "1E";
    SONG_OFF = "1F";

    // Application states
    StateConnect = "Connect";
    StateConnecting = "Connecting";
    StateConnectingTetris = "ConnectingTetris";
    StateSelectMusic = "SelectMusic";
    StateSelectHandicap = "SelectHandicap";
    StateJoiningGame = "JoiningGame";
    StateLobby = "Lobby";
    StateStartingGame = "StartingGame";
    StateJoinGame = "SelectJoinGame";
    StateInGame = "InGame";
    StateFinished = "StateFinished";
    StateError = "StateError";
    StateModeSelect = "ModeSelect";
    StateMatchmaking = "Matchmaking";
    StateOpponentDisconnect = "OpponentDisconnect";
    StateLinkedSetup = "LinkedSetup";
    StateLinked = "Linked";

    // States where the emulated Game Boy may be reset or swapped (no lobby open)
    EmulatorFreeStates = ["Connect", "Connecting", "ConnectingTetris", "SelectMusic", "ModeSelect", "SelectHandicap", "StateError", "LinkedSetup", "Linked"];

    // Player states (sync with server)
    STATE_ALIVE = 0;
    STATE_DEAD = 1;
    STATE_WINNER = 2;

    constructor() {
        this.currentState = this.StateConnect;
        this.music = this.SONG_A;
        this.name = "Foo";
        this.gameCode = "";
        this.users = [];
        this.height = 0;
        this.difficulty = 0;
        this.uuid = "";
        this.isAdmin = false;
        this.isMatchmaking = false;
        this.serial = null;
        this.gb = null;
        this.emulator = null; // in-page Game Boy (js/emulator/EmulatorPanel.js), once opened
        this.linked = null; // Tetris Blast, Tetris 2 etc. instead of Tetris (js/link/LinkedGame.js)
        this.transport = null; // the adapter itself while Tetris DX talks through js/dx/TetrisDxSerial.js
        this.finding = null; // the adapter's hybrid mode while the page finds out which game linked
        this.gameKind = 'tetris'; // sent to the server: 'tetris', or 'dx' for Tetris DX
        this.handshakeRun = 0;

        // Queue for win/lose commands and 0x43 screen-fill
        this.winLoseQueue = [];
        // Unified serial pump state. outQueue holds every command byte we need
        // to clock out to the Game Boy (setup, garbage, tiles, line attacks,
        // win/lose sequences); each entry is [Uint8Array, delayMs].
        this.outQueue = [];
        this.serialActive = false; // pump should keep running
        this.pumpRunning = false;  // a pump tick chain is currently live
        this.gameLoopActive = false;
        this.gameStarting = false; // True during the 2-second game start sequence
        this.gameStartedAt = 0; // Timestamp when game loop actually started
        this.countdownInterval = null; // Interval for matchmaking countdown display
        this.hasPlayedBefore = false; // Tracks if Game Boy has played a game (survives reconnects)

        this.init();
    }

    init() {
        // Load saved username or generate a random one
        var savedName = localStorage.getItem('tetris_username');
        document.getElementById('username').value = savedName || this.generateName();

        // Save username when changed; regenerate random name if blanked out
        document.getElementById('username').addEventListener('change', () => {
            var val = document.getElementById('username').value.trim();
            if (val) {
                localStorage.setItem('tetris_username', val);
            } else {
                localStorage.removeItem('tetris_username');
                document.getElementById('username').value = this.generateName();
            }
        });

        // Bind event listeners
        this.bindEvents();

        // Show initial screen
        this.updateUI();
    }

    generateName() {
        const prefixes = ["Green", "Yellow", "Red", "Purple", "Blue", "Orange"];
        const suffixes = ["I-Piece", "O-Piece", "T-Piece", "J-Piece", "L-Piece", "S-Piece", "Z-Piece"];
        return prefixes[Math.floor(Math.random() * prefixes.length)] + " " +
            suffixes[Math.floor(Math.random() * suffixes.length)];
    }

    bindEvents() {
        // Connect button: prefer WebUSB, fall back to WebSerial.
        const hasUsb = ('usb' in navigator);
        const hasSerial = ('serial' in navigator);
        const transport = hasUsb ? 'usb' : (hasSerial ? 'serial' : null);
        const connectBtn = document.getElementById('btn-connect');
        if (transport) {
            connectBtn.textContent = transport === 'usb' ? 'Connect USB' : 'Connect Serial';
            connectBtn.addEventListener('click', () => this.handleConnectClick(transport));
        } else {
            // Neither WebUSB (Chrome/Edge) nor WebSerial (Firefox 151+, Chrome, Edge): the emulator still works
            connectBtn.style.display = 'none';
            document.getElementById('connect-instructions').textContent =
                'This browser can\'t use the USB adapter (Chrome, Edge or Firefox 151 and later can).';
            document.getElementById('emu-offer-text').textContent = 'You can still play Tetris in your browser with your own ROM.';
        }

        document.getElementById('btn-emulator').addEventListener('click', () => this.handleEmulatorClick());

        // Music buttons
        document.getElementById('btn-music-a').addEventListener('click', () => this.setMusic(this.SONG_A));
        document.getElementById('btn-music-b').addEventListener('click', () => this.setMusic(this.SONG_B));
        document.getElementById('btn-music-c').addEventListener('click', () => this.setMusic(this.SONG_C));
        document.getElementById('btn-music-off').addEventListener('click', () => this.setMusic(this.SONG_OFF));
        document.getElementById('btn-music-next').addEventListener('click', () => this.handleMusicSelected());

        // Create/Join game buttons
        document.getElementById('btn-create-game').addEventListener('click', () => {
            const name = document.getElementById('username').value;
            this.handleCreateGame(name);
        });
        document.getElementById('btn-join-game').addEventListener('click', () => {
            const name = document.getElementById('username').value;
            const code = document.getElementById('game-code-input').value;
            this.handleJoinGame(name, code);
        });

        // Game code input - Enter key
        document.getElementById('game-code-input').addEventListener('keyup', (e) => {
            if (e.key === 'Enter') {
                const name = document.getElementById('username').value;
                const code = document.getElementById('game-code-input').value;
                this.handleJoinGame(name, code);
            }
        });

        // Lobby buttons
        document.getElementById('btn-start-game').addEventListener('click', () => this.handleStartGame());
        document.getElementById('btn-send-rng').addEventListener('click', () => {
            const presetRng = document.getElementById('preset-rng').value;
            this.handleSendPresetRng(presetRng);
        });

        // Finished screen - next game button
        document.getElementById('btn-finished-next').addEventListener('click', () => this.handleStartGame());

        // Matchmaking ready-up button
        document.getElementById('btn-ready-next').addEventListener('click', () => this.handleReadyNext());

        // Mode selection buttons
        document.getElementById('btn-find-match').addEventListener('click', () => this.handleFindMatch());
        document.getElementById('btn-private-lobby').addEventListener('click', () => this.handlePrivateLobby());

        // Matchmaking buttons
        document.getElementById('btn-cancel-matchmaking').addEventListener('click', () => this.handleCancelMatchmaking());

        // Opponent disconnect buttons
        document.getElementById('btn-rematch').addEventListener('click', () => this.handleRematch());
        document.getElementById('btn-back-to-menu').addEventListener('click', () => this.handleBackToMenu());

        // Leave lobby buttons (lobby and finished screens)
        document.getElementById('btn-leave-lobby-pre').addEventListener('click', () => this.handleLeaveLobby());
        document.getElementById('btn-leave-lobby').addEventListener('click', () => this.handleLeaveLobby());

        // Back to menu from create/join screen
        document.getElementById('btn-back-to-mode-select').addEventListener('click', () => {
            this.setState(this.StateModeSelect);
        });

        // Reconnect Game Boy button (mode select screen)
        document.getElementById('btn-reinit-gameboy').addEventListener('click', () => this.handleReinitGameboy());

        // Linked games
        document.getElementById('btn-leave-linked').addEventListener('click', () => {
            // Left during a match: the setup screen shows when the Game Boy is ready again
            const playing = !!(this.linked && this.linked.inMatch);
            if (this.linked) this.linked.close();
            this.setState(playing ? this.StateLinkedSetup : this.StateModeSelect);
        });
        document.getElementById('linked-again').addEventListener('click', () => this.handleFindMatch());
        document.getElementById('btn-linked-next').addEventListener('click', () => this.setState(this.StateModeSelect));
        document.getElementById('btn-linked-start').addEventListener('click', () => this.linked && this.linked.startMatch());
        document.getElementById('btn-linked-speed').addEventListener('click', () => this.linked && this.linked.setRow(0));
        document.getElementById('btn-linked-round').addEventListener('click', () => this.linked && this.linked.setRow(1));
    }

    // Hide all screens
    hideAllScreens() {
        const screens = document.querySelectorAll('.screen');
        screens.forEach(screen => screen.style.display = 'none');
    }

    // Show a specific screen
    showScreen(screenId) {
        this.hideAllScreens();
        const screen = document.getElementById(screenId);
        if (screen) {
            screen.style.display = 'block';
        }
    }

    // Update UI based on current state
    updateUI() {
        switch (this.currentState) {
            case this.StateConnect:
                this.showScreen('screen-connect');
                break;
            case this.StateConnecting:
                this.showScreen('screen-connecting');
                break;
            case this.StateConnectingTetris:
                this.showScreen('screen-connecting-tetris');
                break;
            case this.StateSelectMusic:
                this.showScreen('screen-music');
                break;
            case this.StateSelectHandicap:
                this.showScreen('screen-select-game');
                break;
            case this.StateJoiningGame:
                this.showScreen('screen-joining');
                break;
            case this.StateLobby:
                this.showScreen('screen-lobby');
                this.updateLobbyUI();
                break;
            case this.StateStartingGame:
                this.showScreen('screen-starting');
                break;
            case this.StateInGame:
                this.showScreen('screen-ingame');
                this.updateInGameUI();
                break;
            case this.StateFinished:
                this.showScreen('screen-finished');
                this.updateFinishedUI();
                break;
            case this.StateError:
                this.showScreen('screen-error');
                break;
            case this.StateModeSelect:
                this.showScreen('screen-mode-select');
                document.getElementById('reinit-gameboy').style.display = this.linked && this.linked.emulator ? 'none' : 'block';
                break;
            case this.StateMatchmaking:
                this.showScreen('screen-matchmaking');
                break;
            case this.StateOpponentDisconnect:
                this.showScreen('screen-opponent-disconnect');
                break;
            case this.StateLinkedSetup:
                this.showScreen('screen-linked-setup');
                if (this.linked) this.linked.render();
                break;
            case this.StateLinked:
                this.showScreen('screen-linked');
                if (this.linked) this.linked.render();
                break;
            default:
                console.error("Invalid state:", this.currentState);
        }
    }

    // Set state and update UI
    setState(newState) {
        this.currentState = newState;
        if (this.emulator) this.emulator.setLocked(!this.EmulatorFreeStates.includes(newState));
        this.updateUI();
    }

    // Update lobby display
    updateLobbyUI() {
        document.getElementById('lobby-game-code').textContent = this.isMatchmaking ? 'Matchmaking' : this.gameCode;
        this.renderPlayers('lobby-players', this.users);

        // Show/hide admin controls
        if (this.isAdmin) {
            document.getElementById('lobby-admin-controls').style.display = 'block';
            document.getElementById('lobby-waiting').style.display = 'none';
            document.getElementById('btn-start-game').disabled = this.users.length < 2;
        } else {
            document.getElementById('lobby-admin-controls').style.display = 'none';
            document.getElementById('lobby-waiting').style.display = 'block';
        }
    }

    updateInGameUI() {
        document.getElementById('ingame-game-code').textContent = this.isMatchmaking ? 'Matchmaking' : this.gameCode;
        this.renderPlayers('ingame-players', this.users);
    }

    updateFinishedUI() {
        document.getElementById('finished-game-code').textContent = this.isMatchmaking ? 'Matchmaking' : this.gameCode;
        this.renderPlayers('finished-players', this.users);

        // Clear any previous countdown interval
        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
            this.countdownInterval = null;
        }

        document.getElementById('btn-leave-lobby').style.display = 'inline-block';

        if (this.isMatchmaking) {
            // Matchmaking: both players get ready-up controls
            document.getElementById('finished-admin-controls').style.display = 'none';
            document.getElementById('finished-waiting').style.display = 'none';
            document.getElementById('finished-matchmaking-controls').style.display = 'block';

            // Show greyed out, enable after 5 seconds
            document.getElementById('btn-ready-next').disabled = true;
            document.getElementById('btn-ready-next').textContent = 'Start Next Round';
            document.getElementById('finished-countdown').style.display = 'none';
            document.getElementById('finished-ready-status').textContent = '';

            setTimeout(() => {
                if (this.currentState === this.StateFinished) {
                    document.getElementById('btn-ready-next').disabled = false;
                }
            }, 5000);
        } else {
            // Private lobby: host-only start
            document.getElementById('finished-matchmaking-controls').style.display = 'none';
            if (this.isAdmin) {
                document.getElementById('finished-admin-controls').style.display = 'block';
                document.getElementById('finished-waiting').style.display = 'none';

                // Only allow starting next game when the round is fully over
                // (server reports BETWEEN state) and there are enough players
                var roundOver = this.gb && this.gb.game_status === this.gb.GAME_STATE_BETWEEN;
                if (!roundOver) {
                    // Round still in progress — keep button disabled
                    document.getElementById('btn-finished-next').disabled = true;
                } else {
                    // Round is over — enable after a short delay
                    document.getElementById('btn-finished-next').disabled = true;
                    setTimeout(() => {
                        if (this.currentState === this.StateFinished) {
                            document.getElementById('btn-finished-next').disabled = this.users.length < 2;
                        }
                    }, 5000);
                }
            } else {
                document.getElementById('finished-admin-controls').style.display = 'none';
                document.getElementById('finished-waiting').style.display = 'block';
            }
        }
    }

    // Render player cards
    renderPlayers(containerId, users) {
        const container = document.getElementById(containerId);
        container.innerHTML = '';

        users.forEach(user => {
            const playerDiv = document.createElement('div');
            playerDiv.className = 'col-3';

            let imgSrc, statusText;
            if (user.state === this.STATE_ALIVE) {
                imgSrc = 'images/animation.gif';
                statusText = `Height: ${user.height}<br/>Wins: ${user.num_wins}`;
            } else if (user.state === this.STATE_DEAD) {
                imgSrc = 'images/dead.png';
                statusText = `Game Over<br/>Wins: ${user.num_wins}`;
            } else if (user.state === this.STATE_WINNER) {
                imgSrc = 'images/win.png';
                statusText = `Winner!!!<br/>Wins: ${user.num_wins}`;
            } else {
                imgSrc = 'images/animation.gif';
                statusText = `Wins: ${user.num_wins || 0}`;
            }

            playerDiv.innerHTML = `
        <img src="${imgSrc}" class="gameboy" alt="${user.name}" />
        <p>
          <b>${user.name}</b><br/>
          ${statusText}
        </p>
      `;

            container.appendChild(playerDiv);
        });
    }

    // Connection handling
    handleConnectClick(kind = 'usb') {
        this.serial = (kind === 'serial') ? new SerialWS() : new Serial();
        this.gameKind = 'tetris';
        this.setState(this.StateConnecting);

        this.serial.getDevice().then(() => {
            console.log(`${kind === 'serial' ? 'Serial' : 'USB'} connected, updating status.`);
            this.setState(this.StateConnectingTetris);
            this.attemptTetrisConnection();
        }).catch(c => {
            console.log("Connection cancelled or failed");
            this.setState(this.StateConnect);
        });
    }

    // In-page emulator: the player's own Tetris ROM instead of a Game Boy on the adapter
    handleEmulatorClick() {
        if (this.emulator) {
            this.emulator.open();
            return;
        }
        const button = document.getElementById('btn-emulator');
        button.disabled = true;
        import('./emulator/EmulatorPanel.js').then(({ EmulatorPanel }) => {
            this.emulator = new EmulatorPanel(document.getElementById('emu-host'), {
                game: { name: 'Tetris', files: '.gb or .gbc', identify: identifyTetris },
                emulatorUrl: 'emulator/',
                workletUrl: 'js/emulator/audio-worklet.js',
                storeName: 'gblink-tetris-emulator',
                buttonClass: 'btn btn-secondary',
                onStart: (serial, info) => this.handleEmulatorStart(serial, info),
                onClose: () => this.handleEmulatorClose(),
            });
            this.emulator.setLocked(!this.EmulatorFreeStates.includes(this.currentState));
            return this.emulator.open();
        }).catch(e => {
            console.error('Emulator unavailable:', e);
            document.getElementById('emu-offer-text').textContent = 'The emulator could not be loaded in this browser.';
        }).finally(() => {
            button.disabled = false;
        });
    }

    // A game is running in the emulator (or was just reset): link to it like a newly connected Game Boy.
    // Tetris DX links differently; js/dx/TetrisDxSerial.js makes it look like the original.
    handleEmulatorStart(serial, info) {
        if (info.link) {
            this.startLinked(serial, info);
            return;
        }
        if (this.linked) {
            this.linked.dispose();
            this.linked = null;
        }
        if (this.serial && this.serial.host) this.serial.close();
        this.transport = null;
        this.hasPlayedBefore = false;
        this.gameKind = info.dx ? 'dx' : 'tetris';
        document.getElementById('connecting-dx').style.display = info.dx ? 'block' : 'none';
        document.getElementById('connecting-gb').style.display = info.dx ? 'none' : 'block';
        const linked = (transport) => {
            this.serial = transport;
            this.setState(this.StateConnectingTetris);
            this.attemptTetrisConnection();
        };
        if (!info.dx) {
            linked(serial);
            return;
        }
        import('./dx/TetrisDxSerial.js').then(({ TetrisDxSerial }) => {
            linked(new TetrisDxSerial(this.emulator.emulator));
        });
    }

    // Games played in their own 2-player mode: the page plays player 1 for this Game Boy
    // against another player's (js/link/LinkedGame.js)
    startLinked(serial, info) {
        if (this.linked && this.linked.kind === info.link && this.linked.serial === serial) {
            // Reset: the lobby stays, a match in progress ends and the setup starts again
            this.linked.restarted();
            if (!this.linked.gb) this.setState(this.StateLinkedSetup);
            return;
        }
        this.handshakeRun++;
        this.stopSerialPump();
        if (this.serial && this.serial.host && this.serial !== serial) this.serial.close();
        this.transport = null;
        this.serial = serial;
        if (this.gb) {
            this.gb._closedByUs = true;
            this.gb.ws.close();
            this.gb = null;
        }
        if (this.linked) this.linked.dispose();
        this.linked = null;
        const emulator = this.emulator && serial === this.emulator.serial ? this.emulator.emulator : null;
        import('./link/LinkedGame.js').then(({ LinkedGame }) => {
            this.linked = new LinkedGame(this, serial, info, emulator);
            this.setState(this.StateLinkedSetup);
        });
    }

    handleEmulatorClose() {
        if (this.linked) {
            this.linked.dispose();
            this.linked = null;
        }
        this.handshakeRun++;
        this.stopSerialPump();
        if (this.serial && this.serial.host) this.serial.close();
        this.transport = null;
        this.serial = null;
        this.setState(this.StateConnect);
    }

    attemptTetrisConnection(run = ++this.handshakeRun) {
        console.log("Attempt connection...");
        // Returning to the menu/handshake: stop the in-game pump so it can't
        // send concurrently with the menu's own send/read handshake below.
        this.stopSerialPump();
        this.serial.sendHex("29");
        this.serial.readHex(64).then(result => {
            if (run !== this.handshakeRun) return;
            // Tetris Blast waits on its title with 0x81, Tetris 2 with 0xFD
            const linked = { '81': { title: 'Tetris Blast', link: 'blast' }, 'fd': { title: 'Tetris 2', link: 'tetris2' } }[result.toLowerCase()];
            if (linked) {
                console.log(`${linked.title} found`);
                this.startLinked(this.serial, linked);
                return;
            }
            if (result.toLowerCase() === 'dd') {
                this.startHybridGame(run);
                return;
            }
            if (result === "55") {
                console.log("SUCCESS!");
                this.setState(this.StateSelectMusic);
                this.startMusicTimer();
            } else {
                console.log("Fail");
                setTimeout(() => {
                    if (run === this.handshakeRun) this.attemptTetrisConnection(run);
                }, 100);
            }
        },
            error => {
                if (run !== this.handshakeRun) return;
                this.currentState = this.StateError;
                document.getElementById('error-message').textContent = error;
                this.updateUI();
                console.log("ERROR");
                console.log(error);
            });
    }

    // Tetris DX, Tetris Attack and Tetris Plus answer 0xDD. Their Game Boys drive the clock too,
    // which the adapter answers in its hybrid mode (js/link/HybridAdapter.js)
    async startHybridGame(run) {
        const serial = this.serial;
        const { HybridAdapter, HYBRID_FIRMWARE, identify } = await import('./link/HybridAdapter.js');
        if (run !== this.handshakeRun) return;
        if (!serial.firmwareAtLeast || !serial.firmwareAtLeast(...HYBRID_FIRMWARE)) {
            const have = serial.firmwareVersion ? ` This adapter has ${serial.firmwareVersion.join('.')}.` : '';
            document.getElementById('error-message').textContent =
                `Tetris DX, Tetris Attack and Tetris Plus need GB-Link firmware ${HYBRID_FIRMWARE.join('.')} or newer.${have}`;
            this.setState(this.StateError);
            return;
        }
        const adapter = new HybridAdapter(serial);
        this.finding = adapter;
        let found = null;
        while (!found && run === this.handshakeRun && !adapter.dead) {
            if (await adapter.link()) found = await identify(adapter);
            else await new Promise((resolve) => setTimeout(resolve, 1000 / 60));
        }
        if (this.finding === adapter) this.finding = null;
        if (!found || run !== this.handshakeRun) {
            await adapter.dispose();
            if (run === this.handshakeRun) {
                document.getElementById('error-message').textContent = 'Cannot connect to GB Link Cable Adapter. Please reconnect it to the PC.';
                this.setState(this.StateError);
            }
            return;
        }
        if (found.game !== 'dx') {
            this.startLinked(serial, { title: found.game === 'attack' ? 'Tetris Attack' : 'Tetris Plus', link: found.game, adapter });
            return;
        }
        const { TetrisDxSerial } = await import('./dx/TetrisDxSerial.js');
        this.transport = serial;
        this.gameKind = 'dx';
        this.showDxNote(true);
        this.serial = new TetrisDxSerial(null, { adapter, hello: found.hello, onPrompt: (show) => this.showGameBoyPrompt(show) });
        this.attemptTetrisConnection();
    }

    showDxNote(dx) {
        document.getElementById('connecting-dx').style.display = dx ? 'block' : 'none';
        document.getElementById('connecting-gb').style.display = dx ? 'none' : 'block';
    }

    // Tetris DX on the adapter waits for its player's A before each round
    showGameBoyPrompt(show) {
        const prompt = document.getElementById('gb-prompt');
        prompt.textContent = 'Press A on your Game Boy to start the round.';
        prompt.style.display = show ? 'block' : 'none';
    }

    // Music selection
    setMusic(music) {
        this.music = music;
    }

    startMusicTimer() {
        setTimeout(() => {
            console.log("Sending music");
            if (this.currentState === this.StateSelectMusic) {
                console.log("Music sent");
                this.serial.sendHex(this.music);
                this.serial.read(64);
                this.startMusicTimer();
            } else {
                console.log("invalid state");
            }
        }, 100);
    }

    handleMusicSelected() {
        this.serial.sendHex("50");
        this.serial.read(64);
        // If coming from rematch flow, go directly to matchmaking
        if (this.isMatchmaking) {
            this.handleFindMatch();
        } else {
            this.setState(this.StateModeSelect);
        }
    }

    // Mode selection handlers
    handleFindMatch() {
        console.log("Find Match clicked");
        if (this.linked) {
            this.linked.findMatch(document.getElementById('username')?.value || this.generateName());
            return;
        }
        this.isMatchmaking = true;
        this.name = document.getElementById('username')?.value || this.generateName();
        this.setState(this.StateMatchmaking);
        this.gb = GBWebsocket.findMatch(this.name, this.gameKind);
        this.setGbCallbacks();
    }

    handlePrivateLobby() {
        console.log("Private Lobby clicked");
        this.isMatchmaking = false;
        this.setState(this.StateSelectHandicap);
    }

    handleCancelMatchmaking() {
        console.log("Cancel matchmaking");
        if (this.linked) {
            this.linked.close();
            this.setState(this.StateModeSelect);
            return;
        }
        if (this.gb) {
            this.gb.cancelMatchmaking();
            this.gb = null;
        }
        this.setState(this.StateModeSelect);
    }

    handleRematch() {
        console.log("Rematch - reinitializing Tetris connection");
        // Player has restarted Tetris, need to re-establish connection
        if (this.gb) {
            this.gb._closedByUs = true;
            this.gb.ws.close();
            this.gb = null;
        }
        this.isMatchmaking = true; // Remember we want matchmaking after music
        this.setState(this.StateConnectingTetris);
        this.attemptTetrisConnection();
    }

    handleLeaveLobby() {
        console.log("Leaving lobby");
        if (this.gb) {
            this.gb._closedByUs = true;
            this.gb.ws.close();
            this.gb = null;
        }
        this.gameLoopActive = false;
        this.stopSerialPump();
        this.setState(this.StateModeSelect);
    }

    handleReinitGameboy() {
        console.log("Reconnecting Game Boy");
        const freed = [];
        if (this.finding) {
            freed.push(this.finding.dispose());
            this.finding = null;
        }
        if (this.linked) {
            freed.push(this.linked.dispose());
            this.linked = null;
        }
        // Tetris DX on the adapter: ask the adapter itself again, the game may have changed
        if (this.transport) {
            freed.push(this.serial.close());
            this.serial = this.transport;
            this.transport = null;
            this.showDxNote(false);
        }
        this.hasPlayedBefore = false;
        this.setState(this.StateConnectingTetris);
        const run = ++this.handshakeRun;
        Promise.all(freed).then(() => {
            if (run === this.handshakeRun) this.attemptTetrisConnection(run);
        });
    }

    handleBackToMenu() {
        console.log("Back to menu - reinitializing Tetris connection");
        // Player has restarted Tetris, need to re-establish connection
        if (this.gb) {
            this.gb._closedByUs = true;
            this.gb.ws.close();
            this.gb = null;
        }
        this.isMatchmaking = false;
        this.setState(this.StateConnectingTetris);
        this.attemptTetrisConnection();
    }

    // Handicap timer (not heavily used but keeping for compatibility)
    startHandicapTimer() {
        setTimeout(() => {
            console.log("Handicap timer");
            if (this.currentState === this.StateSelectHandicap) {
                console.log("Sending handicap");
                this.serial.sendHex("00");
                this.serial.read(1).then(result => {
                    var selectedDifficulty = result.data.getUint8(0);
                    console.log("Selected difficulty:", selectedDifficulty);
                    this.difficulty = selectedDifficulty;
                    this.startHandicapTimer();
                });
            } else {
                console.log("Invalid state, stopping handicap timer.");
            }
        }, 100);
    }

    // Game creation/joining
    handleCreateGame(name) {
        console.log("Create new game");
        console.log(name);
        if (this.linked) {
            this.linked.create(name);
            return;
        }
        this.isAdmin = true;
        this.name = name;
        this.setState(this.StateJoiningGame);
        this.gb = GBWebsocket.initiateGame(name, this.gameKind);
        this.setGbCallbacks();
    }

    handleJoinGame(name, gameCode) {
        if (!gameCode || gameCode.length < 1 || gameCode.length > 4) {
            console.error('not a valid input. must have length 1-4');
            return;
        }
        // Clear any previous error message
        var joinError = document.getElementById('join-error');
        if (joinError) joinError.style.display = 'none';
        console.log("Join game");
        console.log(name);
        console.log(gameCode);
        if (this.linked) {
            this.linked.join(name, gameCode);
            return;
        }
        this.isAdmin = false;
        this.name = name;
        this.gameCode = gameCode;
        this.setState(this.StateJoiningGame);
        this.gb = GBWebsocket.joinGame(name, gameCode, this.gameKind);
        this.setGbCallbacks();
    }

    setGbCallbacks() {
        this.gb.onconnected = this.gbConnected.bind(this);
        this.gb.oninfoupdate = this.gbInfoUpdate.bind(this);
        this.gb.ongamestart = this.gbGameStart.bind(this);
        this.gb.ongameupdate = this.gbGameUpdate.bind(this);
        this.gb.ongameend = this.gbGameEnd.bind(this);
        this.gb.onuserinfo = this.gbUserInfo.bind(this);
        this.gb.onlines = this.gbLines.bind(this);
        this.gb.onwin = this.gbWin.bind(this);
        this.gb.onlose = this.gbLose.bind(this);
        this.gb.onerror = this.gbError.bind(this);
        this.gb.onmatchfound = this.gbMatchFound.bind(this);
        this.gb.onopponentdisconnect = this.gbOpponentDisconnect.bind(this);
        this.gb.onplayerready = this.gbPlayerReady.bind(this);
        this.gb.oncountdownstarted = this.gbCountdownStarted.bind(this);
    }

    // WebSocket callbacks
    gbConnected(gb) {
        console.log("We're connected!");
        console.log(gb.users);
        this._handlingDisconnect = false;
        // For matchmaking, stay on the "Finding Opponent..." screen
        // until match_found arrives with actual game data
        if (this.isMatchmaking) {
            return;
        }
        this.gameCode = gb.game_name;
        this.users = gb.users;
        this.setState(this.StateLobby);
    }

    gbInfoUpdate(gb) {
        console.log("Got game update.");
        console.log(gb.users);
        this.gameCode = gb.game_name;
        this.users = gb.users;
        this.isAdmin = gb.admin;

        // If game is starting, reset heights to 0 (server might have stale data)
        if (this.gameStarting) {
            for (var user of this.users) {
                user.height = 0;
            }
        }

        // Check if game ended (status 2 = finished)
        // This handles the case where we didn't receive an explicit win/lose message
        if (gb.game_status === gb.GAME_STATE_FINISHED && this.currentState === this.StateInGame) {
            console.log("Game ended via status update - transitioning to Finished");
            this.setState(this.StateFinished);
        } else {
            this.updateUI();
        }
    }

    gbUserInfo(gb) {
        console.log("userinfo");
        this.uuid = gb.uuid;
    }

    gbError(gb, errorMsg) {
        console.error("Game error:", errorMsg);
        // If lobby not found, show a friendly message and return to join screen
        if (errorMsg === "Game not found." || errorMsg === "Cannot join game" || errorMsg === "Wrong game.") {
            if (this.gb) {
                this.gb._closedByUs = true;
                this.gb.ws.close();
                this.gb = null;
            }
            this.setState(this.StateSelectHandicap);
            var joinError = document.getElementById('join-error');
            if (joinError) {
                joinError.textContent = errorMsg === "Wrong game."
                    ? 'That lobby plays another game.'
                    : 'Lobby not found. Please check the code and try again.';
                joinError.style.display = 'block';
            }
            return;
        }
        document.getElementById('error-message').textContent = errorMsg;
        this.setState(this.StateError);
    }

    gbMatchFound(gb) {
        console.log("Match found!");
        console.log(gb.users);
        this._handlingDisconnect = false;
        this.gameCode = gb.game_name;
        this.users = gb.users;
        this.isAdmin = gb.admin;
        // Go straight to in-game - matchmaking auto-starts the game
        // The game will start via gbGameStart callback
        this.setState(this.StateLobby);
    }

    gbOpponentDisconnect(gb) {
        // Guard against being called twice (from opponent_disconnect msg AND onclose)
        if (this._handlingDisconnect) return;
        this._handlingDisconnect = true;
        console.log("Opponent disconnected!");
        // Stop game loop FIRST to prevent further WS sends
        this.gameLoopActive = false;

        // Clear any running countdown
        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
            this.countdownInterval = null;
        }

        const wasInGame = this.currentState === this.StateInGame;

        if (!this.isMatchmaking) {
            // Private lobby: if we were mid-game, send win sequence to Game Boy
            // since we're the last player standing. Don't close the WebSocket yet —
            // the server sends a "win" message right after "opponent_disconnect"
            // which gbWin will handle to transition to the finished screen.
            if (wasInGame) {
                setTimeout(() => {
                    this.clearOut();
                    this.enqueueOutHex("AA", 50);
                    this.enqueueOutHex("02", 50);
                    this.enqueueOutHex("02", 50);
                    this.enqueueOutHex("02", 50);
                    this.enqueueOutHex("43", 50);
                }, 200);
                // gbWin will fire from the server's "win" message and set StateFinished
            } else {
                // Between rounds: Game Boy already on results screen, just go to finished
                this.setState(this.StateFinished);
            }
            return;
        }

        // Close the old WebSocket (matchmaking only — private lobbies keep it open)
        if (this.gb) {
            this.gb._closedByUs = true;
            this.gb.ws.close();
            this.gb = null;
        }

        // Auto-reconnect for matchmaking
        const reconnect = () => {
            this.setState(this.StateMatchmaking);
            this.gb = GBWebsocket.findMatch(this.name, this.gameKind);
            this.setGbCallbacks();
        };

        if (wasInGame) {
            // Mid-game: send win to Game Boy, show disconnect screen, wait, then reconnect
            setTimeout(() => {
                this.clearOut();
                this.enqueueOutHex("AA", 50);
                this.enqueueOutHex("02", 50);
                this.enqueueOutHex("02", 50);
                this.enqueueOutHex("02", 50);
                this.enqueueOutHex("43", 50);
            }, 200);
            // Show the win/disconnect screen, then wait 5 seconds for the
            // Game Boy to fully process the win sequence before reconnecting
            this.setState(this.StateOpponentDisconnect);
            setTimeout(reconnect, 5000);
        } else {
            // Between rounds or any other state: Game Boy already on results screen
            reconnect();
        }
    }

    gbGameStart(gb) {
        console.log("Got game start.");

        // Clear any running countdown from ready-up
        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
            this.countdownInterval = null;
        }

        // Track that Game Boy has played at least one game (survives matchmaking reconnects)
        this.hasPlayedBefore = true;

        // Store whether a game loop was running (for subsequent rounds)
        const wasLoopRunning = this.gameLoopActive;

        // Clear any leftover commands and stop running loop
        this.winLoseQueue = [];
        this.gameLoopActive = false;
        this.gameStarting = true; // Block lines during game start sequence
        this.height = 0; // Reset our height for new game

        // Reset all users' heights for new game (prevents stale UI data)
        for (var user of this.users) {
            user.height = 0;
        }

        // Switch to in-game UI immediately
        this.setState(this.StateInGame);
        this.updateInGameUI();

        // Tell server our height is 0 so other players see us at 0
        this.gb.sendHeight(0);

        // Helper function to send game start sequence
        const sendGameStartSequence = () => {
            // Clear any stale queued bytes on subsequent games, then make sure
            // the pump is running so it drains the setup sequence we enqueue
            // below (the GB is clocked only while the pump sends).
            this.clearOut();
            this.startSerialPump();

            // Step 1: start game message
            if (this.isFirstGame()) {
                console.log('is first game');
                this.enqueueOutHex("60", 150);
                this.enqueueOutHex("29", 4);
            } else {
                console.log('is not first game');
                // begin communication again
                this.enqueueOutHex("60", 70);
                this.enqueueOutHex("02", 70);
                this.enqueueOutHex("02", 70);
                this.enqueueOutHex("02", 70);
                this.enqueueOutHex("79", 330);
                // send start
                this.enqueueOutHex("60", 150);
                this.enqueueOutHex("29", 70);
            }

            console.log("Sending initial garbage", gb.garbage);
            // Step 3: send initial garbage
            for (var i = 0; i < gb.garbage.length; i++) {
                this.enqueueOut(new Uint8Array([gb.garbage[i]]), 4);
            }

            // Step 4: send master again
            this.enqueueOutHex("29", 8);
            console.log("Sending tiles");
            // Step 5: send tiles
            for (var i = 0; i < gb.tiles.length; i++) {
                this.enqueueOut(new Uint8Array([gb.tiles[i]]), 4);
            }

            // Step 6: and go
            this.enqueueOutHex("30", 70);
            this.enqueueOutHex("00", 70);
            this.enqueueOutHex("02", 70);
            this.enqueueOutHex("02", 70);
            this.enqueueOutHex("20", 70);

            // Wait 2 seconds and then start game
            setTimeout(() => {
                this.gameLoopActive = true;
                this.gameStartedAt = Date.now(); // Track when game started
                this.startGameTimer();

                // Wait an additional 2 seconds before accepting lines/heights
                setTimeout(() => {
                    this.gameStarting = false;
                    console.log("Game start complete, now accepting lines");
                }, 2000);
            }, 2000);
        };

        // If game loop was running, wait for it to stop before sending
        // Otherwise (first game), start immediately like React
        if (wasLoopRunning) {
            setTimeout(sendGameStartSequence, 400);
        } else {
            sendGameStartSequence();
        }
    }

    gbGameUpdate(gb) {
        console.log("game update");
    }

    gbGameEnd(gb) {
        console.log("game end");
    }

    gbLines(gb, lines) {
        // Only process lines if game is actually running and not starting
        // This prevents lines from interfering with game start sequence
        if (this.currentState !== this.StateInGame || this.gameStarting) {
            console.log("Ignoring lines - game not in progress or starting");
            return;
        }
        console.log("lines");
        this.enqueueOut(new Uint8Array([lines]), 10);
    }

    gbWin(gb) {
        console.log("WIN!");
        // Only send win sequence if game loop was still active
        // (gbOpponentDisconnect may have already sent it)
        if (this.gameLoopActive) {
            this.gameLoopActive = false;
            setTimeout(() => {
                this.clearOut();
                this.enqueueOutHex("AA", 50); // aa indicates BAR FULL
                this.enqueueOutHex("02", 50); // finish
                this.enqueueOutHex("02", 50); // finish
                this.enqueueOutHex("02", 50); // finish
                this.enqueueOutHex("43", 50); // go to final screen
            }, 200);
        }
        this.setState(this.StateFinished);
    }

    gbLose(gb) {
        console.log("LOSE!");
        // Stop game loop and clear buffer before sending lose sequence
        this.gameLoopActive = false;
        setTimeout(() => {
            this.clearOut();
            this.enqueueOutHex("77", 50); // 77 indicates other player has reached 30 lines
            this.enqueueOutHex("02", 50); // finish
            this.enqueueOutHex("02", 50); // finish
            this.enqueueOutHex("02", 50); // finish
            this.enqueueOutHex("43", 50); // go to final screen
        }, 200);
        this.setState(this.StateFinished);
    }

    // Game logic
    isFirstGame() {
        if (this.hasPlayedBefore) {
            return false;
        }
        for (var u of this.users) {
            if (u.num_wins > 0) {
                return false;
            }
        }
        return true;
    }

    updateHeight(height) {
        if (this.height !== height) {
            console.log("Height increased!");
            console.log(height);
            this.height = height;
            if (this.gb) this.gb.sendHeight(height);
        }
    }

    // --- Unified serial pump ------------------------------------------------
    // The Game Boy is the SPI slave: the link only advances when we send a
    // byte, and the firmware replies to exactly one byte per byte we send. So
    // there must be a single sender and a single reader, and we must consume
    // one reply for every send. This one pump serializes ALL outgoing bytes —
    // setup, garbage, tiles, line attacks, win/lose sequences, and the
    // steady-state height poll — through outQueue, reading one reply each.
    //
    // Only replies to the steady-state poll byte are interpreted as game
    // events; replies to queued command bytes are read and discarded. That
    // exactly mirrors the old WebUSB behaviour, where the device dropped the
    // replies to fire-and-forget bufSend() writes. Over WebSerial those
    // dropped replies instead piled up in the framed _dataQueue, so the poll
    // loop read ever-staler frames until the link desynced and locked up.

    enqueueOut(data, delay) {
        this.outQueue.push([data, delay]);
        this.startSerialPump();
    }

    enqueueOutHex(hex, delay) {
        const data = new Uint8Array(hex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
        this.enqueueOut(data, delay);
    }

    clearOut() {
        this.outQueue = [];
    }

    startSerialPump() {
        this.serialActive = true;
        if (this.pumpRunning) return;
        this.pumpRunning = true;
        this.serialStep();
    }

    stopSerialPump() {
        this.serialActive = false;
    }

    serialStep() {
        if (!this.serialActive) {
            this.pumpRunning = false;
            return;
        }

        let byte, delay, isPoll;
        if (this.outQueue.length > 0) {
            // Always drain queued command bytes first, regardless of game
            // phase, so setup/garbage/tiles and win/lose sequences clock out.
            const item = this.outQueue.shift();
            byte = item[0];
            delay = item[1];
            isPoll = false;
        } else if (this.gameLoopActive && !this.gameStarting) {
            // Steady state: poll with our current outgoing byte.
            let b;
            if (this.winLoseQueue.length > 0) {
                b = this.winLoseQueue.shift();
                console.log("Sending from winLoseQueue:", b.toString(16));
            } else if (this.gb) {
                const aliveOpponents = this.gb.getOtherUsers().filter(u => u.state === this.STATE_ALIVE);
                const heights = [0].concat(aliveOpponents.map(u => u.height || 0));
                b = Math.max(...heights);
            } else {
                b = 0;
            }
            byte = new Uint8Array([b]);
            delay = 100;
            isPoll = true;
        } else {
            // Nothing to send yet (game starting, or idle between rounds): don't
            // clock the GB, matching the old loop's no-send startup window.
            setTimeout(() => this.serialStep(), 50);
            return;
        }

        this.serial.send(byte).then(() => this.serial.read(64)).then(result => {
            if (!this.serialActive) { this.pumpRunning = false; return; }
            if (isPoll) this.handlePollReply(result);
            setTimeout(() => this.serialStep(), delay);
        }).catch(() => {
            // A read timeout (a transient hiccup over WebSerial) must not kill
            // the pump. The old loop had no catch here, so a single timeout
            // permanently stopped communication; keep the pump alive and retry.
            if (this.serialActive) {
                setTimeout(() => this.serialStep(), 50);
            } else {
                this.pumpRunning = false;
            }
        });
    }

    handlePollReply(result) {
        const value = (new Uint8Array(result.data.buffer))[0];
        if (value < 20) {
            this.updateHeight(value);
        } else if ((value >= 0x80) && (value <= 0x85)) { // lines sent
            console.log("Sending lines!", value.toString(16));
            if (this.gb) this.gb.sendLines(value);
        } else if (value === 0x77) { // we won by reaching 30 lines
            console.log("We reached 30 lines - WIN!");
            this.setState(this.StateFinished);
            if (this.gb) this.gb.sendReached30Lines();
        } else if (value === 0xaa) { // we lost...
            // Ignore topped-out signal in first 3 seconds (may be leftover from previous game)
            const timeSinceStart = Date.now() - this.gameStartedAt;
            if (timeSinceStart < 3000) {
                console.log("Ignoring topped out - game just started (" + timeSinceStart + "ms ago)");
            } else {
                console.log("We topped out - LOSE!");
                this.setState(this.StateFinished);
                if (this.gb) this.gb.sendDead();
            }
        } else if (value === 0xFF) { // screen is filled after loss
            // Queue the final screen command instead of using buffer directly
            this.winLoseQueue.push(0x43);
        }
    }

    // Back-compat shim: the game-start sequence kicks the loop off here.
    startGameTimer() {
        this.startSerialPump();
    }


    handleStartGame() {
        this.gb.sendStart();
        this.setState(this.StateStartingGame);
    }

    handleSendPresetRng(presetRng) {
        this.gb.sendPresetRng(presetRng);
    }

    handleReadyNext() {
        this.gb.sendReadyNext();
        document.getElementById('btn-ready-next').disabled = true;
        document.getElementById('btn-ready-next').textContent = 'Waiting for opponent...';
    }

    gbPlayerReady(gb, uuid) {
        var readyUser = this.users.find(u => u.uuid === uuid);
        var name = readyUser ? readyUser.name : 'A player';
        document.getElementById('finished-ready-status').textContent = name + ' is ready!';
    }

    gbCountdownStarted(gb, seconds) {
        var countdown = seconds;
        var countdownEl = document.getElementById('finished-countdown');
        countdownEl.style.display = 'block';
        countdownEl.textContent = 'Game starting in ' + countdown + 's...';

        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
        }
        this.countdownInterval = setInterval(() => {
            countdown--;
            if (countdown <= 0) {
                clearInterval(this.countdownInterval);
                this.countdownInterval = null;
                countdownEl.textContent = 'Starting...';
            } else {
                countdownEl.textContent = 'Game starting in ' + countdown + 's...';
            }
        }, 1000);
    }
}

// Identifies the game from the ROM header. link: the game's id in js/link/;
// model: the Game Boy model to run it as
function identifyTetris(rom) {
    const title = String.fromCharCode(...rom.subarray(0x134, 0x144)).replace(/\0+$/, '');
    if (title.startsWith('TETRIS DX')) return { title: 'Tetris DX', dx: true };
    if (title === 'TETRIS ATTACK') return { title: 'Tetris Attack', link: 'attack' };
    if (title === 'TETRIS PLUS') return { title: 'Tetris Plus', link: 'plus' };
    if (title === 'TETRIS2') return { title: 'Tetris 2', link: 'tetris2' };
    // Runs as a Game Boy Color: on a Super Game Boy, which has no link port, the game offers no link play
    if (title === 'TETRIS BLAST') return { title: 'Tetris Blast', link: 'blast', model: 2 };
    if (title !== 'TETRIS') return null;
    const checksum = (rom[0x14E] << 8) | rom[0x14F];
    return { title: checksum === 0x89B5 ? 'Tetris (Japan)' : 'Tetris' };
}

// Initialize application when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new OnlineTetris();
});
