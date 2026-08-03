# Media Controls

A GNOME Shell extension that puts whatever is currently playing into the top
panel, with playback controls and an iOS-style now-playing card.

Works with any player that speaks MPRIS2 — Spotify, Firefox, Chrome, VLC,
Rhythmbox, mpv, and so on.

<p align="center">
  <a href="https://extensions.gnome.org/extension/10373/media-controller/">
    <img src="public/gnome-logo.png"
         alt="Install from GNOME Extensions"
         width="260">
  </a>
</p>

<p align="center">
  <a href="https://extensions.gnome.org/extension/10373/media-controller/"><strong>Install from GNOME Extensions →</strong></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/GNOME-47--50-4A86CF?logo=gnome&logoColor=white" alt="GNOME Shell">
  <img src="https://img.shields.io/badge/License-GPL--2.0-green.svg" alt="License">
</p>

<p align="center">
  <img src="public/img-1.png" alt="The panel indicator and the now-playing card, showing album art, a seek bar and transport controls" width="700">
</p>
<p align="center"><em>The panel indicator and the now-playing card.</em></p>

## Features

- **Panel indicator** showing the player icon, track title and artist, in a
  fixed-width slot so it does not resize as tracks change.
- **Scrolling text**, off by default: text too wide for that slot loops past it
  carousel-style instead of being ellipsized.
- **Playback controls** in the panel: previous, skip backward, play/pause, skip
  forward, next, plus optional shuffle and loop buttons. Each button can be
  shown or hidden independently.
- **Click the album art** to raise the player's own window. Players that do not
  support being raised leave the artwork as a plain picture.
- **Now-playing card** when you click the indicator: album art, a wrapping title,
  artist and album, a draggable seek bar with elapsed and remaining time, and
  large transport controls including skip buttons — with shuffle on the card's
  left edge and loop on its right, aligned with the controls.
- **Player switching** when more than one player is running: a strip of app icons
  appears on its own row at the top of the card, and clicking one puts that player
  in the panel. The choice sticks until that player quits, so picking VLC is not
  undone by Spotify starting a new track. Three icons are shown at most; any beyond
  that collapse into a `+3` button that reveals the rest. With a single player the
  strip stays hidden and the card looks exactly as it always did.
- **One player at a time**: starting playback in one player pauses whichever
  other player was playing, so hitting play in VLC no longer leaves Spotify
  running underneath it. Players already playing when the extension starts are
  left alone, and the whole behavior can be switched off.
- **Shuffle and loop** control the player directly: shuffle toggles on and off,
  loop cycles between off, repeating the whole queue, and repeating one track,
  and an engaged mode lights up in your accent color.
- **Configurable panel position**: far left, left, center, right, or far right.
- Follows the shell theme, including light/dark and your accent color.

Skip buttons only appear for players that support seeking; shuffle and loop
only for players that expose them over MPRIS.

## Requirements

- GNOME Shell 47 to 50
- A player exposing the MPRIS2 D-Bus interface

## Install

```sh
make install
```

Then log out and back in — GNOME Shell only scans for new extensions at startup,
and on Wayland it cannot be restarted in place. After logging back in:

```sh
make enable
make prefs     # open the preferences window
```

Or install directly from the official GNOME Extensions website:

**https://extensions.gnome.org/extension/10373/media-controller/**

## Development

```sh
make check     # syntax-check the JS, schema and metadata
make schemas   # compile the GSettings schema
make pack      # build a distributable zip
make logs      # follow this extension's shell log output
make uninstall
```

Note that changes to an already-loaded extension also require a log out and back
in on Wayland, because the shell caches ES modules for the life of the process.

## Settings

<p align="center">
  <img src="public/img-2.png" alt="The preferences window, on the Panel tab, with toggles for the playback controls and track information" width="600">
</p>
<p align="center"><em>The preferences window (<code>make prefs</code>).</em></p>

| Setting                                           | Default         | Description                                             |
| ------------------------------------------------- | --------------- | ------------------------------------------------------- |
| `panel-position`                                  | `right`         | `far-left`, `left`, `center`, `right`, `far-right`      |
| `show-previous` / `show-play-pause` / `show-next` | on              | Panel transport buttons                                 |
| `show-seek-backward` / `show-seek-forward`        | off             | Panel skip buttons                                      |
| `show-shuffle` / `show-loop`                      | off             | Panel shuffle and loop buttons                          |
| `show-player-icon`                                | on              | Application icon in the panel                           |
| `show-title` / `show-artist`                      | on / off        | Panel text                                              |
| `panel-text-width`                                | 300             | Width of the panel text, in pixels                      |
| `scroll-text`                                     | off             | Scroll text wider than that, rather than ellipsizing it |
| `scroll-direction`                                | `left-to-right` | `left-to-right` or `right-to-left`                      |
| `scroll-speed`                                    | 30              | Scrolling speed, in pixels per second                   |
| `controls-on-left`                                | off             | Put the buttons before the text                         |
| `hide-when-inactive`                              | on              | Hide the indicator when no player is running            |
| `card-show-art`                                   | on              | Album art in the card                                   |
| `card-show-player-switcher`                       | on              | Icons for switching players, when more than one is running |
| `pause-others-on-play`                            | on              | Starting one player pauses whichever other was playing  |
| `card-show-seek-bar`                              | on              | Seek bar in the card                                    |
| `card-show-seek-buttons`                          | on              | Skip buttons in the card                                |
| `card-show-shuffle` / `card-show-loop`            | on              | Shuffle and loop buttons on the card's edges            |
| `seek-step-seconds`                               | 10              | How far the skip buttons jump, in seconds               |
| `card-width`                                      | 400             | Card width in pixels (400–560)                          |

## Layout

| File                                           | Purpose                                     |
| ---------------------------------------------- | ------------------------------------------- |
| [src/extension.js](src/extension.js)           | Panel indicator, menu, panel placement      |
| [src/mediaCard.js](src/mediaCard.js)           | The now-playing card                        |
| [src/scrollingLabel.js](src/scrollingLabel.js) | The fixed-width panel label and its marquee |
| [src/mpris.js](src/mpris.js)                   | MPRIS2 D-Bus client and player tracking     |
| [src/artCache.js](src/artCache.js)             | Resolves and caches album art               |
| [src/prefs.js](src/prefs.js)                   | Preferences window                          |

`mpris.js` and `artCache.js` deliberately import only `gi://` modules, never
`resource:///org/gnome/shell/…`, so they can be exercised outside the shell.

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).

This is the license required for submission to
[extensions.gnome.org](https://extensions.gnome.org).

## Notes

Album art from streaming players and browsers arrives as an `https://` URL. It is
downloaded once and cached under `~/.cache/media-controls/art/`.

Players that do not report a track length (most web players) simply do not show a
seek bar. `playerctld` is ignored, since it mirrors another player that is
already tracked.
