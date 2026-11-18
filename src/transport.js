// SPDX-License-Identifier: GPL-2.0-or-later
/* transport.js: playback helpers shared by the panel indicator and the card.
 *
 * Button sensitivity is deliberately not shared: the card's buttons carry
 * `message-media-control`, which the theme styles for `:insensitive`, while the
 * panel's `mc-panel-control` has no such rule and dims itself. */

import Clutter from 'gi://Clutter';

/* MPRIS positions and lengths are in microseconds. */
export const US_PER_SECOND = 1000000;

/* Signed skip offset in microseconds; direction is -1 or 1. */
export function seekOffset(settings, direction) {
    return direction * settings.get_int('seek-step-seconds') * US_PER_SECOND;
}

export function playPauseIconName(player) {
    return player.isPlaying
        ? 'media-playback-pause-symbolic'
        : 'media-playback-start-symbolic';
}

/* MPRIS LoopStatus values, in the order the loop button cycles through them. */
const LOOP_CYCLE = ['None', 'Playlist', 'Track'];

/* A non-standard status lands at index -1, so the first click turns looping
 * off, the one state that is always safe to ask for. */
export function nextLoopStatus(status) {
    return LOOP_CYCLE[(LOOP_CYCLE.indexOf(status) + 1) % LOOP_CYCLE.length];
}

export function loopIconName(status) {
    return status === 'Track'
        ? 'media-playlist-repeat-song-symbolic'
        : 'media-playlist-repeat-symbolic';
}

/* The shell's own volume thresholds: muted only at zero, then thirds. */
const VOLUME_ICONS = [
    'audio-volume-muted-symbolic',
    'audio-volume-low-symbolic',
    'audio-volume-medium-symbolic',
    'audio-volume-high-symbolic',
];

/* volume is 0 to 1, or past it on players that amplify. */
export function volumeIconName(volume) {
    if (volume <= 0)
        return VOLUME_ICONS[0];
    return VOLUME_ICONS[Math.min(3, Math.ceil(volume * 3))];
}

/* Guarded: this runs on every sync, and a style class change restyles the
 * whole subtree. `.mc-mode-on` colors the icon with the accent color. */
export function setToggleStyle(button, on) {
    if (on === button.has_style_class_name('mc-mode-on'))
        return;
    if (on)
        button.add_style_class_name('mc-mode-on');
    else
        button.remove_style_class_name('mc-mode-on');
}

/* St's hover comes from an enter/leave count that goes stale when a widget
 * turns non-reactive under the pointer, so it is resynced from the pointer. */
export function setReactive(actor, reactive) {
    if (actor.reactive === reactive)
        return;
    actor.reactive = reactive;
    syncHover(actor);
}

export function syncHover(actor) {
    if (!actor.track_hover)
        return;

    let hovered = false;
    if (actor.reactive && actor.mapped) {
        const [x, y] = global.get_pointer();
        const target = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        hovered = !!target && actor.contains(target);
    }
    actor.hover = hovered;
}
