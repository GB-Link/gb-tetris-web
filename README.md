# GB-Tetris-Web

Web frontend for online Game Boy Tetris multiplayer. Connects to a Game Boy via WebUSB or WebSerial, or runs Tetris in the browser, and to the game server via WebSockets.

## Requirements

- Chrome or Chromium based browser or Firefox 151+
- [GBLink firmware](https://github.com/starlarkus/GBLink-Firmware) or [reconfigurable firmware (legacy)](https://github.com/starlarkus/gb-link-firmware-reconfigurable)
- Game Boy with Tetris cartridge, or your Tetris ROM to play in the browser

## Playing in the browser (no Game Boy needed)

- Press **Use emulator** instead of Connect USB and choose your Tetris ROM (.gb, or .gbc for Tetris DX). The game runs on the left of the page (above it on phones), and the site links up with it just as with a Game Boy on the adapter. Your ROM stays on your device.
- Choose your music, then find a match or create or join a private lobby as usual. The Game Boy shows the copyright screen for a few seconds first; Start skips it.
- You play with players on real Game Boys and with other emulator players alike.
- Keys: arrows, X or A for A, Z or S for B, Enter for Start, Shift for Select. Gamepads work too, and phones get on-screen buttons. The buttons above the screen switch the sound and fullscreen.
- The browser keeps the ROMs you load, so next time the game is one click away under **Kept in this browser**. **Change game** pauses the game and shows that list. **Reset** restarts the game like switching the Game Boy off and on, and **Close** stops the emulator. These three wait while a match is on.
- It also works in browsers that can't use the USB adapter, such as phone browsers.
- The emulator is [mGBA](https://mgba.io) 0.10.5 by Jeffrey Pfau and contributors, used under the Mozilla Public License 2.0 (`emulator/LICENSE-mGBA.txt`). Its source is at [github.com/mgba-emu/mgba](https://github.com/mgba-emu/mgba/tree/0.10.5).

## HTTPS Note

WebUSB requires HTTPS. For local development, `localhost` is allowed without HTTPS

## Configuration

WebSocket server settings are in `js/gbwebsocket.js`:

## Troubleshooting
- Currently when refreshing the web page most of the time the pico/usb device needs to be reset. Unplugging or pressing reset on the USB adapter should acomplish this
- If on linux you may need to edit Udev rules. See here https://stackoverflow.com/questions/30983221/chrome-app-fails-to-open-usb-device
