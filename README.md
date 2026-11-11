# GB-Tetris-Web

Web frontend for online Game Boy Tetris multiplayer. Connects to a Game Boy via WebUSB or WebSerial, or runs Tetris in the browser, and to the game server via WebSockets.

## Supported games

- Tetris
- Tetris DX
- Tetris Blast
- Tetris 2
- Tetris Attack
- Tetris Plus

## Requirements

- Chrome or Chromium based browser or Firefox 151+
- [GBLink firmware](https://github.com/GB-Link/GBLink-Firmware) or [reconfigurable firmware (legacy)](https://github.com/starlarkus/gb-link-firmware-reconfigurable). Tetris DX, Tetris Attack and Tetris Plus need GBLink firmware 3.0.0 or newer on the adapter.
- Game Boy with one of the supported games, or its ROM to play in the browser

## Playing in the browser (no Game Boy needed)

- Press **Use emulator** instead of Connect USB and choose your game's ROM. The game runs on the left of the page (above it on phones), and the site links up with it just as with a Game Boy on the adapter. Your ROM stays on your device.
- Choose your music, then find a match or create or join a private lobby as usual. The Game Boy shows the copyright screen for a few seconds first; Start skips it.
- You play with players on real Game Boys and with other emulator players alike.
- Keys: arrows, X or A for A, Z or S for B, Enter for Start, Shift for Select. Gamepads work too, and phones get on-screen buttons. The buttons above the screen switch the sound and fullscreen.
- The browser keeps the ROMs you load, so next time the game is one click away under **Kept in this browser**. **Change game** pauses the game and shows that list. **Reset** restarts the game like switching the Game Boy off and on, and **Close** stops the emulator. These three wait while a match is on.
- It also works in browsers that can't use the USB adapter, such as phone browsers.
- The emulator is [mGBA](https://mgba.io) 0.10.5 by Jeffrey Pfau and contributors, used under the Mozilla Public License 2.0 (`emulator/LICENSE-mGBA.txt`). Its source is at [github.com/mgba-emu/mgba](https://github.com/mgba-emu/mgba/tree/0.10.5).


Tetris DX plays like Tetris: choose your music, then find a match or create or join a private lobby. You play other Tetris DX players.

- When Tetris DX asks for your player data, pick it with A (GUEST is fine).
- With a Game Boy on the adapter, press A on your Game Boy when the page asks, to start each round.
- START pauses your own Game Boy only. The other player keeps playing.


These are played in the game's own 2-player mode. Your Game Boy plays as the second player and the site plays the first player for it, so both of you play on your own Game Boy as if linked by a cable.

- Leave the game on its title screen when you connect. The site links with it straight away, and you set up on your Game Boy before looking for an opponent:
  - Tetris Blast: pick your stage and level and press A.
  - Tetris 2: pick your speed and round on your Game Boy. On the page, choose which of the two rows you are changing, and the music.
  - Tetris Attack: pick your level and press A, then your stage and press A. Choose the music on the page.
  - Tetris Plus: pick your level and press A. Matches are best of three.
- Press **Next**, then find a match, or create or join a private lobby of two. Both players need the same game. Different releases of a game play together (Japan, USA, revisions). Matchmaking only pairs players of the same game.
- In matchmaking the first match starts as soon as both players are in. After that, and in private lobbies, the lobby leader starts each match from the page.
- After a match your Game Boy goes back to its setup. In Tetris Blast, pick your level again and press A (the loser first chooses Yes to play again). In Tetris Attack, press A on the level and stage screens again. Tetris Plus shows its title for a moment, then its level screen.
- If the other player leaves or resets their Game Boy during a match, your Game Boy leaves the match and goes back to its setup.
- On a slow connection, Tetris 2 waits for the other Game Boy between rounds.
- In Tetris 2 only the first player can pause a 2-player game, so neither player can pause here.
- With a Game Boy on the adapter, keep this page in front while you play. Browsers slow down pages in the background, and the Game Boy then loses the link.

## HTTPS Note

WebUSB requires HTTPS. For local development, `localhost` is allowed without HTTPS

## Configuration

WebSocket server settings are in `js/gbwebsocket.js`:

## Troubleshooting
- Currently when refreshing the web page most of the time the pico/usb device needs to be reset. Unplugging or pressing reset on the USB adapter should acomplish this
- If on linux you may need to edit Udev rules. See here https://stackoverflow.com/questions/30983221/chrome-app-fails-to-open-usb-device
