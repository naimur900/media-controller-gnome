// SPDX-License-Identifier: GPL-2.0-or-later
/* playerVolume.js: turns the player on screen up or down, for scrolling over
 * the panel indicator. A player that takes its volume over MPRIS (Spotify, VLC,
 * mpv) has that set, as the card's volume bar does. Browsers ignore MPRIS
 * volume, so for them it is their sound stream's volume, the per-app one the
 * sound settings show, found by the app's name. */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gvc from 'gi://Gvc';

/* The shell's step for scrolling its own volume slider, so a notch here moves
 * as far as one over the sound icon. */
const SCROLL_STEP = 0.02;

/* A player announces the volume it was set to a moment later. Until then the
 * next notch builds on the value written, not the stale one, or fast scrolling
 * would go nowhere. As long as the card's VOLUME_HOLD_MS. */
const HOLD_US = 400 * 1000;

/* The shortest name allowed to match by prefix, as "vlc" matches VLC's stream
 * "VLC media player (LibVLC 3.0.21)". */
const MIN_PREFIX = 3;

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

/* Notches from a scroll event, positive for up; 0 for one that is no volume
 * change: sideways, or the discrete copy of a smooth scroll. Read as the
 * shell's sound icon reads them, following the fingers even with natural
 * scrolling. */
export function scrollSteps(event) {
    if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
        return 0;

    const direction = event.get_scroll_direction();
    if (direction === Clutter.ScrollDirection.UP)
        return 1;
    if (direction === Clutter.ScrollDirection.DOWN)
        return -1;
    if (direction !== Clutter.ScrollDirection.SMOOTH)
        return 0;

    const [, dy] = event.get_scroll_delta();
    /* GNOME 47 has no INVERTED flag. */
    const inverted = Clutter.ScrollFlags?.INVERTED &&
        (event.get_scroll_flags() & Clutter.ScrollFlags.INVERTED);
    return inverted ? dy : -dy;
}

/* Lowercase letters and digits only, so "Google Chrome" and "google-chrome"
 * agree. */
function appKey(text) {
    return (text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/* Every name the player goes by: its MPRIS identity, the desktop's name for
 * its app, its desktop entry in full and the last part of a reverse-DNS one
 * (org.mozilla.firefox), and the app in its bus name (firefox.instance_1_23). */
function playerKeys(player) {
    const entry = player.desktopEntry;
    const busApp = player.busName.replace(MPRIS_PREFIX, '').split('.')[0];
    const names = [player.identity, player.displayName, entry,
        entry.split('.').pop(), busApp];
    return new Set(names.map(appKey).filter(key => key.length > 0));
}

/* A stream carries the name its app gave the sound server, which can run
 * longer than the player's ("VLC media player (LibVLC 3.0.21)") or shorter
 * ("mpv" for "mpv Media Player"), so it may match by prefix. Its icon name
 * must match exactly: it can be as generic as "audio". */
function isPlayerStream(stream, keys) {
    const name = appKey(stream.get_name());
    const icon = appKey(stream.get_icon_name());
    for (const key of keys) {
        if (key === name || key === icon)
            return true;
        if (Math.min(key.length, name.length) >= MIN_PREFIX &&
            (key.startsWith(name) || name.startsWith(key)))
            return true;
    }
    return false;
}

/* As the shell's sound menu sets a stream: silence is muted, not only zero,
 * and any sound unmutes. volume is in the mixer's units. */
function setStreamVolume(stream, volume) {
    const silent = volume < 1;
    const changed = stream.set_volume(silent ? 0 : volume);
    if (silent !== stream.is_muted)
        stream.change_is_muted(silent);
    if (changed)
        stream.push_volume();
}

export class PlayerVolume {
    /* mixer: an open Gvc.MixerControl, which stays the caller's to close. */
    constructor(mixer) {
        this._mixer = mixer;
        /* The last volume written over MPRIS: {busName, volume, until}. */
        this._written = null;
    }

    /* Moves the player's volume by `steps` scroll notches. Returns the new
     * level and the top of its scale, or null when the player has no volume
     * to change: a browser with no sound stream open, for one. */
    step(player, steps) {
        const delta = steps * SCROLL_STEP;
        if (player.canSetVolume)
            return this._stepPlayer(player, delta);
        return this._stepStreams(player, delta);
    }

    /* Scrolling up stops at full; a player already past it (mpv and VLC go
     * beyond 1) keeps its level until scrolled down. */
    _stepPlayer(player, delta) {
        const now = GLib.get_monotonic_time();
        const written = this._written;
        const current = written?.busName === player.busName && now < written.until
            ? written.volume
            : player.volume;

        const maxLevel = Math.max(1, current);
        const level = clamp(current + delta, 0, maxLevel);
        if (level !== current)
            player.setVolume(level);
        this._written = {busName: player.busName, volume: level, until: now + HOLD_US};
        return {level, maxLevel};
    }

    /* Each stream moves by the same step, so a browser's tabs keep their
     * balance. The loudest is what you hear, so it is the level reported. */
    _stepStreams(player, delta) {
        if (this._mixer.get_state() !== Gvc.MixerControlState.READY)
            return null;

        const keys = playerKeys(player);
        const streams = this._mixer.get_sink_inputs().filter(stream =>
            !stream.is_event_stream && !stream.is_virtual &&
            isPlayerStream(stream, keys));

        const norm = this._mixer.get_vol_max_norm();
        let result = null;
        for (const stream of streams) {
            const current = stream.is_muted ? 0 : stream.volume / norm;
            const maxLevel = Math.max(1, current);
            const level = clamp(current + delta, 0, maxLevel);
            setStreamVolume(stream, Math.round(level * norm));
            if (!result || level > result.level)
                result = {level, maxLevel};
        }
        return result;
    }
}
