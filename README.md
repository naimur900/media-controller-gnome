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
  <img src="https://img.shields.io/badge/GNOME-47--51-4A86CF?logo=gnome&logoColor=white" alt="GNOME Shell">
  <img src="https://img.shields.io/badge/License-GPL--2.0-green.svg" alt="License">
</p>

<p align="center">
  <img src="public/showcase.png" alt="Four views of the card: timed lyrics on an album-art backdrop, the frosted-glass backdrop in a track's colors, the player list in the dark style, and the sound output list in the light style" width="700">
</p>
<p align="center"><em>Synced lyrics, colors from the album art, and the player and sound output lists in the dark and light styles.</em></p>

## What's new in 3.4

- **Sound output**: a button at the bottom right of the card shows the output in
  use and opens a list of your speakers, headphones, HDMI and Bluetooth devices
  to switch between. It switches the whole system's output, as the sound menu
  does, and what was playing keeps playing. Switch it off under Card in the
  preferences.

## What's new in 3.2

- **Colors from album art**: the card fills with a dark, frosted-glass backdrop
  blurred from the artwork, in the shell's light and dark style alike, and
  fades to each new track's colors. On by default; switch it off under Card in
  the preferences for the plain card.

## What's new in 3.1

- **Light card**: the card follows the shell's light style, turning white with
  dark text and controls when the shell is light, and staying dark as before
  when it is dark.

## What's new in 3.0

- **Volume bar** along the bottom of the card, in your accent color, for the
  player's own volume.
- **Player list**: the player's name sits beside the volume bar, and opens a
  list of every running player — with its artwork and what it is playing — to
  switch between. It replaces the strip of icons beside the settings button.
- **Proper app names**: players go by the names GNOME gives their apps, so
  Firefox is "Firefox" rather than "Mozilla org.mozilla.firefox".
- **Bigger album art** at every size, with Large the new default, and a wider
  card by default: 460 pixels.

## Features

- **Panel indicator** showing the player icon, track title and artist, in a
  fixed-width slot so it does not resize as tracks change.
- **Scrolling text**, on by default: text too wide for that slot scrolls past it
  carousel-style instead of being ellipsized, once for each new track.
- **Playback controls** in the panel: previous, skip backward, play/pause, skip
  forward, next, plus optional shuffle and loop buttons. Each button can be
  shown or hidden independently.
- **Click the album art** to raise the player's own window. Players that do not
  support being raised leave the artwork as a plain picture.
- **Now-playing card** when you click the indicator: album art in three sizes, a
  wrapping title, artist and album, a draggable seek bar with elapsed and
  remaining time, and large transport controls including skip buttons — with
  shuffle on the card's left edge and loop on its right, aligned with the
  controls. Along the bottom, under a hairline, the player's name sits beside a
  volume bar in your accent color, with the sound output at the end.
- **Volume bar** that sets the player's own volume, by dragging, scrolling,
  clicking or with the arrow keys. It follows changes made in the player itself.
- **Sound output** at the bottom right of the card: an icon for the output in
  use — speakers, headphones, HDMI or Bluetooth — that opens a list of every
  available output to switch to, named plainly: "Built-in" rather than the
  chipset, and Bluetooth and USB devices by their own names. It switches the
  system's output, as the sound menu does, so every app moves with it, browsers
  included, and what was playing keeps playing. It appears once there is more
  than one output to choose from.
- **Player switching** when more than one player is running: clicking the
  player's name opens a list of every running player with its artwork and what
  it is playing. Picking one puts that player in the card and the panel. The
  choice sticks through the noise of a track changing, and is released as soon
  as you press play somewhere else — that player takes over. The list floats
  over the card, never taller than the card has room for, and scrolls beyond
  that. A browser counts as one player, showing the tab that played last:
  browsers publish only that tab over MPRIS.
- **Proper app names**: players go by the names GNOME gives their apps — the
  ones in the app grid and the dash — so Firefox is "Firefox" and Chrome is
  "Google Chrome", whatever the player calls itself.
- **One player at a time**: starting playback in one player pauses whichever
  other player was playing, so hitting play in VLC no longer leaves Spotify
  running underneath it. Players already playing when the extension starts are
  left alone, and the whole behavior can be switched off.
- **Shuffle and loop** control the player directly: shuffle toggles on and off,
  loop cycles between off, repeating the whole queue, and repeating one track,
  and an engaged mode lights up in your accent color.
- **Lyrics** for the song that is playing, from the player itself, an `.lrc`
  file beside the track, or [LRCLIB](https://lrclib.net). Timed lyrics light up
  line by line and follow the song; clicking a line plays from there. The button
  only appears for music players — not for browsers, nor for films in video
  players.
- **Colors from album art**, on by default: the card fills with a frosted-glass
  backdrop blurred from the album art, and fades from one track's colors to the
  next. It is the same dark glass in the shell's light and dark style alike:
  the controls turn white to sit on it, and the player list becomes a sheet of
  the same glass. Tracks without artwork keep the plain card, as does switching
  the option off.
- **Configurable panel position**: far left, left, center, right, or far right.
- Follows the shell theme: the card is light in the shell's light style and
  dark in its dark style, and wears your accent color in both. With colors from
  album art, it is the artwork's dark glass in both instead.

Skip buttons only appear for players that support seeking; shuffle and loop
only for players that expose them over MPRIS. The volume bar sets the player's
own volume rather than the system's, so it appears only for players that let it
be set over MPRIS — not for browsers.

## Requirements

- GNOME Shell 47 to 51
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
| `panel-position`                                  | `left`          | `far-left`, `left`, `center`, `right`, `far-right`      |
| `show-previous` / `show-play-pause` / `show-next` | on              | Panel transport buttons                                 |
| `show-seek-backward` / `show-seek-forward`        | off             | Panel skip buttons                                      |
| `show-shuffle` / `show-loop`                      | off             | Panel shuffle and loop buttons                          |
| `show-player-icon`                                | on              | Application icon in the panel                           |
| `show-title` / `show-artist`                      | on              | Panel text                                              |
| `panel-text-width`                                | 300             | Width of the panel text, in pixels                      |
| `scroll-text`                                     | on              | Scroll text wider than that once per track, rather than ellipsizing it |
| `scroll-direction`                                | `left-to-right` | `left-to-right` or `right-to-left`                      |
| `scroll-speed`                                    | 30              | Scrolling speed, in pixels per second                   |
| `controls-on-left`                                | off             | Put the buttons before the text                         |
| `hide-when-inactive`                              | on              | Hide the indicator when no player is running            |
| `card-show-art`                                   | on              | Album art in the card                                   |
| `card-art-size`                                   | `large`         | `small`, `medium` or `large`: 80, 104 or 136 pixels     |
| `card-art-backdrop`                               | on              | Frosted backdrop blurred from the album art, behind the card |
| `card-show-player-switcher`                       | on              | Player button beside the volume bar, listing every player to switch to |
| `pause-others-on-play`                            | on              | Starting one player pauses whichever other was playing  |
| `card-show-seek-bar`                              | on              | Seek bar in the card                                    |
| `card-show-seek-buttons`                          | on              | Skip buttons in the card                                |
| `card-show-shuffle` / `card-show-loop`            | on              | Shuffle and loop buttons on the card's edges            |
| `card-show-volume`                                | on              | Volume bar under the card's controls, for the player's own volume |
| `card-show-output-switcher`                       | on              | Sound output button at the card's bottom right, switching the system's output |
| `card-show-lyrics-button`                         | on              | Lyrics button in the card, for music players            |
| `lyrics-online-lookup`                            | off             | Ask LRCLIB when the player and `.lrc` files have none   |
| `lyrics-height`                                   | 320             | Height of the lyrics in pixels (160–560), made shorter when the screen has no room |
| `seek-step-seconds`                               | 10              | How far the skip buttons jump, in seconds               |
| `card-width`                                      | 460             | Card width in pixels (400–560)                          |

## Layout

| File                                           | Purpose                                     |
| ---------------------------------------------- | ------------------------------------------- |
| [src/extension.js](src/extension.js)           | Panel indicator, menu, panel placement      |
| [src/mediaCard.js](src/mediaCard.js)           | The now-playing card                        |
| [src/lyricsPanel.js](src/lyricsPanel.js)       | The card's lyrics view                      |
| [src/cardList.js](src/cardList.js)             | The sheet the card's footer lists are built on |
| [src/playerList.js](src/playerList.js)         | The card's list of players to switch to     |
| [src/outputList.js](src/outputList.js)         | The card's list of sound outputs            |
| [src/soundOutputs.js](src/soundOutputs.js)     | The system's sound outputs, and switching them |
| [src/lyrics.js](src/lyrics.js)                 | Finds lyrics and parses LRC                 |
| [src/scrollingLabel.js](src/scrollingLabel.js) | The fixed-width panel label and its marquee |
| [src/mpris.js](src/mpris.js)                   | MPRIS2 D-Bus client and player tracking     |
| [src/playerIcons.js](src/playerIcons.js)       | Matches a player to its app: icon, name, kind |
| [src/artCache.js](src/artCache.js)             | Resolves and caches album art               |
| [src/backdrop.js](src/backdrop.js)             | Blurs album art into the card's backdrop    |
| [src/prefs.js](src/prefs.js)                   | Preferences window                          |
| [src/compat.js](src/compat.js)                 | Differences between GNOME Shell versions    |
| [src/updateNotice.js](src/updateNotice.js)     | What's-new notification after an update     |

`mpris.js`, `artCache.js`, `backdrop.js`, `lyrics.js` and `soundOutputs.js` deliberately
import only `gi://` modules, never `resource:///org/gnome/shell/…`, so they can be
exercised outside the shell.

## Credits

- [FrigoreD](https://github.com/FrigoreD) — lyrics in the card, plus fixes for
  live streams, switching players and the scrolling title.

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).

This is the license required for submission to
[extensions.gnome.org](https://extensions.gnome.org).

## Notes

Album art from streaming players and browsers arrives as an `https://` URL. It is
downloaded once and cached under `~/.cache/media-controls/art/`. The card's
backdrops are small images made from that art, kept under
`~/.cache/media-controls/backdrops/`: the last sixteen, the rest removed.

Players that do not report a track length (most web players) simply do not show a
seek bar. `playerctld` is ignored, since it mirrors another player that is
already tracked.

Looking lyrics up online sends the track's title, artist, album and length to
lrclib.net, and only while the lyrics are open. It is off by default; turn
`lyrics-online-lookup` on to search beyond the player and local `.lrc` files.
