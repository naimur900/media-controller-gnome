// SPDX-License-Identifier: GPL-2.0-or-later
/* mediaCard.js: the iOS-style "now playing" card shown when the panel
 * indicator is clicked. */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { Slider } from 'resource:///org/gnome/shell/ui/slider.js';

import { cssUrl } from './artCache.js';
import { BackdropMaker } from './backdrop.js';
import { boxOrientation } from './compat.js';
import { Equalizer } from './equalizer.js';
import { LyricsPanel, lyricsIcon } from './lyricsPanel.js';
import { OutputList } from './outputList.js';
import { PlayerKind } from './playerIcons.js';
import { PlayerList } from './playerList.js';
import { StreamVolume } from './playerVolume.js';
import {
    US_PER_SECOND, loopIconName, nextLoopStatus, playPauseIconName,
    seekOffset, setReactive, setToggleStyle, syncHover, volumeIconName
} from './transport.js';

const POSITION_POLL_SECONDS = 1;

/* The title wraps, so the card is as tall as the text needs. Podcast and DJ-set
 * titles can run to hundreds of characters and push the controls off screen;
 * this caps them at roughly three lines. */
const MAX_TITLE_CHARS = 120;

/* A footer list rises out of its button: gap above the button, inset from the
 * card's edges, and how far it slides in. */
const LIST_GAP = 6;
const LIST_INSET = 10;
const LIST_SLIDE = 12;
const LIST_MS = 180;

/* One track's backdrop fading into the next. */
const BACKDROP_MS = 500;

/* Keyed by the `card-art-size` nick. `icon` keeps the fallback icon's inset
 * close to the artwork's; the radius scales with the size. */
const ART_SIZES = {
    'small': {size: 80, radius: 14, icon: 36},
    'medium': {size: 104, radius: 18, icon: 46},
    'large': {size: 136, radius: 22, icon: 60},
};
const DEFAULT_ART_SIZE = 'large';

/* How long the volume slider ignores the player after the user moves it: each
 * write echoes back as PropertiesChanged, which would pull the thumb back
 * mid-drag. */
const VOLUME_HOLD_MS = 400;

/* A browser's volume bar while the browser has no sound stream open: still in
 * place, so the footer does not jump, but plainly out of use. */
const VOLUME_IDLE_OPACITY = 110;

/* Spreading iterates code points, so the cut never splits a surrogate pair
 * (an emoji) in half. */
function truncate(text, maxLength) {
    const chars = [...text];
    if (chars.length <= maxLength)
        return text;
    return `${chars.slice(0, maxLength - 1).join('').trimEnd()}…`;
}

/* `4:07`, or `1:23:20` once there are hours. */
function formatTime(micros) {
    const total = Math.max(0, Math.floor(micros / US_PER_SECOND));
    const seconds = total % 60;
    const minutes = Math.floor(total / 60) % 60;
    const hours = Math.floor(total / 3600);

    const pad = value => value.toString().padStart(2, '0');
    if (hours > 0)
        return `${hours}:${pad(minutes)}:${pad(seconds)}`;
    return `${minutes}:${pad(seconds)}`;
}

/* Secondary text is dimmed by opacity, which stays legible in light and dark
 * themes where a fixed color would not. */
const DIM_OPACITY = 160;

/* `message-media-control` is the shell's own media button style, so hover,
 * active and insensitive states follow the theme. */
function iconButton(iconName, styleClass) {
    return new St.Button({
        style_class: `message-media-control ${styleClass}`,
        can_focus: true,
        child: new St.Icon({icon_name: iconName}),
    });
}

/* Press feedback: shrink, then spring back past full size. */
function pop(actor) {
    actor.remove_all_transitions();
    actor.set_scale(0.7, 0.7);
    actor.ease({
        scale_x: 1,
        scale_y: 1,
        duration: 300,
        mode: Clutter.AnimationMode.EASE_OUT_BACK,
    });
}

/* The layer a footer list floats in. It asks for no room, so the list can
 * never hold the card open (it once kept a closing card at its old height),
 * and it seats the list on every allocation, so the list follows its button
 * wherever the card's height moves it. anchor() returns the y of the list's
 * bottom edge, in the layer's coordinates. */
const ListLayer = GObject.registerClass(
class ListLayer extends St.Widget {
    _init(list, anchor) {
        /* Clipped to the card: the list sits close to the card's sides, and
         * its shadow would spill past them onto whatever is behind the menu. */
        super._init({
            x_expand: true,
            y_expand: true,
            visible: false,
            clip_to_allocation: true,
        });
        this._list = list;
        this._anchor = anchor;
        this.add_child(list);
    }

    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }

    vfunc_get_preferred_height(_forWidth) {
        return [0, 0];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);

        /* No taller than the room above the button; a longer list scrolls. */
        const width = Math.max(0, box.get_width() - 2 * LIST_INSET);
        const bottom = this._anchor() - LIST_GAP;
        const [, natural] = this._list.get_preferred_height(width);
        const height = Math.min(natural, Math.max(0, bottom - LIST_INSET));
        this._list.allocate(Clutter.ActorBox.new(
            LIST_INSET, bottom - height, LIST_INSET + width, bottom));
    }
});

export const MediaCard = GObject.registerClass({
    Signals: {
        /* The player's window was raised; the menu should close. */
        'activated': {},
        'open-preferences': {},
        /* Carries the picked player's MPRIS bus name. */
        'player-selected': {param_types: [GObject.TYPE_STRING]},
        /* Carries the picked sound output's mixer id. */
        'output-selected': {param_types: [GObject.TYPE_UINT]},
        /* Carries the backdrop's edge color as CSS, or '' for the plain card. */
        'backdrop-changed': {param_types: [GObject.TYPE_STRING]},
    },
}, class MediaCard extends St.Widget {
    _init(artCache, lyricsSource, soundOutputs, settings) {
        /* Three layers: the album-art backdrop, the content over it, and on
         * top the footer's lists and their scrim, floating over the content. */
        super._init({
            style_class: 'mc-card',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
        });

        this._buildBackdrop();

        /* Held to the top at its own height: stretched, the header's expanding
         * action column would grow and the artwork slide to the middle. */
        this._content = new St.BoxLayout({
            style_class: 'mc-card-content',
            ...boxOrientation(Clutter.Orientation.VERTICAL),
            x_expand: true,
            y_align: Clutter.ActorAlign.START,
        });
        this.add_child(this._content);

        this._artCache = artCache;
        this._soundOutputs = soundOutputs;
        this._streamVolume = new StreamVolume(soundOutputs.mixer,
            () => this._syncVolume());
        this._settings = settings;
        /* Stage pixels; known once the card is first opened. */
        this._maxHeight = Infinity;
        this._player = null;
        this._playerSignals = [];
        this._timeoutId = 0;
        this._seekRefreshId = 0;
        this._volumeHoldId = 0;
        this._dragging = false;
        this._dragPlayer = null;
        this._dragLength = 0;
        this._active = false;
        this._currentArtUrl = null;
        this._artGeneration = 0;
        this._artPath = null;
        this._artSize = ART_SIZES[DEFAULT_ART_SIZE];
        this._backdropMaker = new BackdropMaker();
        this._backdropGeneration = 0;
        this._backdropPath = null;
        this._length = 0;
        this._position = 0;
        this._players = [];
        this._activePlayer = null;
        /* The footer list that is open, of _playerPopup and _outputPopup. */
        this._popup = null;
        this._focusBeforePopup = null;

        this._buildHeader();
        this._buildLyrics(lyricsSource);
        this._buildSeekBar();
        this._buildControls();
        this._buildFooter();
        this._buildPopups();

        this._settingsSignals = [
            this._settings.connect('changed::card-show-art', () => this.sync()),
            this._settings.connect('changed::card-show-seek-bar', () => this.sync()),
            this._settings.connect('changed::card-show-seek-buttons', () => this.sync()),
            this._settings.connect('changed::card-show-shuffle', () => this.sync()),
            this._settings.connect('changed::card-show-loop', () => this.sync()),
            this._settings.connect('changed::card-show-volume', () => this.sync()),
            this._settings.connect('changed::card-show-lyrics-button', () => this.sync()),
            this._settings.connect('changed::card-show-player-switcher',
                () => this._updatePicker()),
            this._settings.connect('changed::card-show-output-switcher',
                () => this._updateOutputs()),
            this._settings.connect('changed::card-width', () => this._applyWidth()),
            this._settings.connect('changed::lyrics-height', () => this._applyLyricsHeight()),
            this._settings.connect('changed::card-art-size', () => this._applyArtSize()),
            this._settings.connect('changed::card-art-backdrop',
                () => this._onBackdropSettingChanged()),
        ];
        this._applyWidth();
        this._applyArtSize();

        this._soundOutputs.connectObject('changed', () => this._updateOutputs(), this);
        this._updateOutputs();

        this.connect('destroy', () => this._onDestroy());
    }

    /* Two image layers, so a new track's backdrop fades in over the last, and
     * a sheen over both. None asks for room: the content alone sizes the card. */
    _buildBackdrop() {
        this._backdropLayers = [0, 1].map(() => new St.Widget({
            style_class: 'mc-card-backdrop',
            x_expand: true,
            y_expand: true,
        }));
        this._sheen = new St.Widget({
            style_class: 'mc-card-sheen',
            x_expand: true,
            y_expand: true,
        });

        for (const layer of [...this._backdropLayers, this._sheen])
            this.add_child(layer);
    }

    /* With the artwork hidden it was never fetched, so the track's art is
     * asked for again. */
    _onBackdropSettingChanged() {
        if (this._artPath || !this._settings.get_boolean('card-art-backdrop')) {
            this._updateBackdrop();
            return;
        }
        this._currentArtUrl = null;
        this.sync();
    }

    /* With no art yet the last backdrop stays up: the art may be on its way,
     * and the paths that know there is none drop it themselves. */
    _updateBackdrop() {
        if (!this._settings.get_boolean('card-art-backdrop')) {
            this._dropBackdrop();
            return;
        }
        if (!this._artPath)
            return;

        /* A newer track must win even if its backdrop is done first. */
        const generation = ++this._backdropGeneration;
        this._backdropMaker.make(this._artPath).then(backdrop => {
            if (generation === this._backdropGeneration)
                this._showBackdrop(backdrop);
        });
    }

    _dropBackdrop() {
        this._backdropGeneration++;
        this._showBackdrop(null);
    }

    /* Fade to a new backdrop ({path, color} from BackdropMaker.make()), or
     * away to the plain card for null. */
    _showBackdrop(backdrop) {
        const path = backdrop?.path ?? null;
        if (path === this._backdropPath)
            return;
        this._backdropPath = path;

        /* A new image always arrives on the upper layer; the one on screen
         * moves underneath first, so the fade starts from it. Removing a
         * transition skips its onComplete, so a fade cut short cannot clear a
         * layer it no longer owns. */
        const [lower, upper] = this._backdropLayers;
        lower.remove_all_transitions();
        upper.remove_all_transitions();
        if (upper.style) {
            lower.style = upper.style;
            lower.opacity = 255;
        }

        const style = path ? `background-image: ${cssUrl(path)};` : null;
        upper.style = style;
        upper.opacity = 0;

        const fade = {
            duration: BACKDROP_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                lower.style = null;
            },
        };
        if (path)
            upper.ease({opacity: 255, ...fade});
        else
            lower.ease({opacity: 0, ...fade});

        /* The lists are sheets of the same glass. */
        this._playerList.style = style;
        this._outputList.style = style;
        this.emit('backdrop-changed', backdrop?.color ?? '');
    }

    /* The players to offer, in a stable order, and the one on screen. Called
     * on every sync. */
    setPlayers(players, active) {
        this._players = players;
        this._activePlayer = active;
        this._playerList.setPlayers(players, active?.busName ?? null);
        this._updatePicker();
    }

    /* The button names the player on screen. Only with a second player is there
     * a choice; until then it is a plain name tag with no arrow. */
    _updatePicker() {
        const player = this._activePlayer;
        const show = !!player && this._settings.get_boolean('card-show-player-switcher');
        const choice = show && this._players.length > 1;

        this._pickerButton.visible = show;
        if (show) {
            this._pickerIcon.gicon = player.appIcon;
            this._pickerLabel.text = player.displayName;
        }
        this._pickerArrow.visible = choice;
        this._pickerButton.can_focus = choice;
        setReactive(this._pickerButton, choice);

        if (!choice && this._popup === this._playerPopup)
            this._closePopup();
        this._updateFooter();
    }

    /* Like the shell's sound menu, the button appears only once there is a
     * second output to switch to. Its icon is the output in use. */
    _updateOutputs() {
        const outputs = this._soundOutputs.outputs;
        const active = this._soundOutputs.active;
        this._outputList.setOutputs(outputs, this._soundOutputs.activeId);

        const show = outputs.length > 1 &&
            this._settings.get_boolean('card-show-output-switcher');
        this._outputButton.visible = show;
        if (active)
            this._outputIcon.gicon = active.gicon;
        else
            this._outputIcon.icon_name = 'audio-speakers-symbolic';
        this._outputButton.accessible_name = active?.name
            ? _('Sound output: %s').format(active.name)
            : _('Sound output');

        if (!show && this._popup === this._outputPopup)
            this._closePopup();
        this._updateFooter();
    }

    _buildHeader() {
        const header = new St.BoxLayout({
            style_class: 'mc-card-header',
            ...boxOrientation(Clutter.Orientation.HORIZONTAL),
        });

        /* Clicking the artwork raises the player's window. A button (itself an
         * St.Bin) so hover and focus come from the theme. */
        this._artButton = new St.Button({
            style_class: 'mc-art',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._artFallback = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            opacity: DIM_OPACITY,
        });
        this._artButton.set_child(this._artFallback);
        this._artButton.connect('clicked', () => {
            this._player?.raise();
            this.emit('activated');
        });
        header.add_child(this._artButton);

        const textBox = new St.BoxLayout({
            style_class: 'mc-card-text',
            ...boxOrientation(Clutter.Orientation.VERTICAL),
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this._titleLabel = new St.Label({style_class: 'mc-card-title', text: _('Nothing playing')});
        this._artistLabel = new St.Label({style_class: 'mc-card-artist', text: ''});
        this._albumLabel = new St.Label({style_class: 'mc-card-album', text: ''});
        /* The card has a fixed width, so a long title wraps; mid-word breaks
         * are the fallback for a word too long for a line. */
        this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._titleLabel.clutter_text.line_wrap = true;
        this._titleLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._artistLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._albumLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        textBox.add_child(this._titleLabel);
        textBox.add_child(this._artistLabel);
        textBox.add_child(this._albumLabel);
        header.add_child(textBox);

        /* A full-height column on the right: lyrics button and gear on top, the
         * equalizer centred against the art. The track text is its own column,
         * so it never runs underneath them. */
        const actions = new St.BoxLayout({
            style_class: 'mc-card-actions',
            ...boxOrientation(Clutter.Orientation.VERTICAL),
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
        });

        this._prefsButton = new St.Button({
            style_class: 'mc-app-button',
            can_focus: true,
            y_align: Clutter.ActorAlign.START,
            child: new St.Icon({icon_name: 'emblem-system-symbolic', icon_size: 16}),
        });
        this._prefsButton.connect('clicked', () => this.emit('open-preferences'));

        this._lyricsButton = new St.Button({
            style_class: 'mc-app-button mc-lyrics-button',
            can_focus: true,
            toggle_mode: true,
            y_align: Clutter.ActorAlign.START,
            accessible_name: _('Lyrics'),
            child: new St.Icon({gicon: lyricsIcon(), icon_size: 16}),
        });
        this._lyricsButton.child.set_pivot_point(0.5, 0.5);
        this._lyricsButton.connect('notify::checked', () => {
            pop(this._lyricsButton.child);
            this._lyrics.setOpen(this._lyricsButton.checked);
            this._onLyricsTimingChanged();
        });

        const topRow = new St.BoxLayout({
            style_class: 'mc-card-actions-top',
            ...boxOrientation(Clutter.Orientation.HORIZONTAL),
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
        });
        topRow.add_child(this._lyricsButton);
        topRow.add_child(this._prefsButton);
        actions.add_child(topRow);

        /* Expanding is what pushes this off the gear and centres it. */
        const status = new St.BoxLayout({
            style_class: 'mc-card-status',
            ...boxOrientation(Clutter.Orientation.HORIZONTAL),
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
        });

        this._equalizer = new Equalizer();
        status.add_child(this._equalizer);
        actions.add_child(status);

        header.add_child(actions);

        /* No spacing in this column: the gap above the lyrics is their own
         * padding, so it grows with them instead of appearing at once. */
        this._headerColumn = new St.BoxLayout({
            ...boxOrientation(Clutter.Orientation.VERTICAL),
        });
        this._headerColumn.add_child(header);
        this._content.add_child(this._headerColumn);
    }

    _buildLyrics(source) {
        this._lyrics = new LyricsPanel(source, this._settings);
        this._lyrics.connect('seek-requested', (_panel, position) => {
            this._player?.setPosition(position);
            this._refreshPositionSoon();
        });
        this._lyrics.connect('timing-changed', () => this._onLyricsTimingChanged());
        this._headerColumn.add_child(this._lyrics);
    }

    /* Timed lyrics need the position polled, and want it now. */
    _onLyricsTimingChanged() {
        this._updateTimer();
        if (this._lyrics.wantsPosition)
            this._refreshPosition();
    }

    _buildSeekBar() {
        this._seekBox = new St.BoxLayout({
            style_class: 'mc-seek-box',
            ...boxOrientation(Clutter.Orientation.VERTICAL),
        });

        this._slider = new Slider(0);
        this._slider.add_style_class_name('mc-seek');
        this._slider.x_expand = true;

        /* The track can change mid-drag and sync() would move `_length`, so
         * the player and length being scrubbed are pinned. */
        this._slider.connect('drag-begin', () => {
            this._dragging = true;
            this._dragPlayer = this._player;
            this._dragLength = this._length;
            return Clutter.EVENT_PROPAGATE;
        });
        this._slider.connect('drag-end', () => {
            this._dragging = false;
            const player = this._dragPlayer;
            const length = this._dragLength;
            this._dragPlayer = null;

            if (player && player === this._player && length > 0)
                player.setPosition(Math.round(this._slider.value * length));
            return Clutter.EVENT_PROPAGATE;
        });
        /* Keep the timestamps under the thumb while scrubbing. */
        this._slider.connect('notify::value', () => {
            if (this._dragging && this._dragLength > 0) {
                this._updateTimeLabels(this._slider.value * this._dragLength,
                    this._dragLength);
            }
        });

        const times = new St.BoxLayout({
            style_class: 'mc-time-box',
            ...boxOrientation(Clutter.Orientation.HORIZONTAL),
        });
        this._positionLabel = new St.Label({
            style_class: 'mc-time',
            text: '0:00',
        });
        this._remainingLabel = new St.Label({
            style_class: 'mc-time',
            text: '-0:00',
        });
        this._remainingLabel.x_align = Clutter.ActorAlign.END;
        this._remainingLabel.x_expand = true;
        times.add_child(this._positionLabel);
        times.add_child(this._remainingLabel);

        this._seekBox.add_child(this._slider);
        this._seekBox.add_child(times);
        this._content.add_child(this._seekBox);
    }

    _buildControls() {
        /* A box, not a BinLayout: shuffle packs left, loop right, and the
         * expanding transport cluster centres between them. A BinLayout ignores
         * the edge buttons' alignment and piles them under the play button. */
        const row = new St.BoxLayout({
            style_class: 'mc-controls-row',
            ...boxOrientation(Clutter.Orientation.HORIZONTAL),
        });

        this._shuffleButton = iconButton('media-playlist-shuffle-symbolic',
            'mc-control-button mc-mode-button');
        this._shuffleButton.y_align = Clutter.ActorAlign.CENTER;
        this._shuffleButton.connect('clicked', () => this._toggleShuffle());

        this._loopButton = iconButton('media-playlist-repeat-symbolic',
            'mc-control-button mc-mode-button');
        this._loopButton.y_align = Clutter.ActorAlign.CENTER;
        this._loopButton.connect('clicked', () => this._cycleLoop());

        const controls = new St.BoxLayout({
            style_class: 'mc-card-controls',
            ...boxOrientation(Clutter.Orientation.HORIZONTAL),
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._prevButton = iconButton('media-skip-backward-symbolic', 'mc-control-button');
        this._backButton = iconButton('media-seek-backward-symbolic', 'mc-control-button mc-seek-button');
        this._playButton = iconButton('media-playback-start-symbolic', 'mc-control-button mc-play-button');
        this._forwardButton = iconButton('media-seek-forward-symbolic', 'mc-control-button mc-seek-button');
        this._nextButton = iconButton('media-skip-forward-symbolic', 'mc-control-button');

        this._prevButton.connect('clicked', () => this._player?.previous());
        this._playButton.connect('clicked', () => this._player?.playPause());
        this._nextButton.connect('clicked', () => this._player?.next());
        this._backButton.connect('clicked', () => this._skip(-1));
        this._forwardButton.connect('clicked', () => this._skip(1));

        controls.add_child(this._prevButton);
        controls.add_child(this._backButton);
        controls.add_child(this._playButton);
        controls.add_child(this._forwardButton);
        controls.add_child(this._nextButton);

        row.add_child(this._shuffleButton);
        row.add_child(controls);
        row.add_child(this._loopButton);
        this._content.add_child(row);
    }

    /* The bottom line, under a hairline: the player picker beside its volume,
     * and the sound output at the end. */
    _buildFooter() {
        this._footer = new St.BoxLayout({
            style_class: 'mc-card-footer',
            ...boxOrientation(Clutter.Orientation.HORIZONTAL),
        });
        this._buildPicker();
        this._buildVolume();
        this._buildOutputButton();

        /* Closer together than the footer's spacing, so the output icon sits
         * as near the slider as the volume icon does. */
        const levels = new St.BoxLayout({
            style_class: 'mc-footer-levels',
            ...boxOrientation(Clutter.Orientation.HORIZONTAL),
            x_expand: true,
        });
        levels.add_child(this._volumeBox);
        levels.add_child(this._outputButton);

        this._footer.add_child(this._pickerButton);
        this._footer.add_child(levels);
        this._content.add_child(this._footer);
    }

    _buildPicker() {
        this._pickerIcon = new St.Icon({
            style_class: 'mc-player-picker-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._pickerLabel = new St.Label({
            style_class: 'mc-player-picker-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._pickerLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        /* Points up, the way the list opens, and turns over while it is open. */
        this._pickerArrow = new St.Icon({
            style_class: 'mc-player-picker-arrow',
            icon_name: 'pan-up-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._pickerArrow.set_pivot_point(0.5, 0.5);

        const box = new St.BoxLayout({
            style_class: 'mc-player-picker-box',
            ...boxOrientation(Clutter.Orientation.HORIZONTAL),
        });
        box.add_child(this._pickerIcon);
        box.add_child(this._pickerLabel);
        box.add_child(this._pickerArrow);

        this._pickerButton = new St.Button({
            style_class: 'mc-player-picker',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: _('Switch player'),
            child: box,
        });
        this._pickerButton.connect('clicked',
            () => this._togglePopup(this._playerPopup));
    }

    /* The system's sound output, not the player's: picking one moves every app
     * that plays through the default output. At rest it looks like the volume
     * icon; like the gear, it is round when hovered. */
    _buildOutputButton() {
        this._outputIcon = new St.Icon({
            style_class: 'mc-output-button-icon',
            icon_name: 'audio-speakers-symbolic',
        });
        this._outputButton = new St.Button({
            style_class: 'mc-app-button mc-output-button',
            can_focus: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            child: this._outputIcon,
        });
        this._outputButton.connect('clicked',
            () => this._togglePopup(this._outputPopup));
    }

    /* With no volume bar to fill the line, the output button still keeps to
     * its end. Expanding beside the volume bar would take half its room. */
    _updateFooter() {
        this._outputButton.x_expand = !this._volumeBox.visible;
        this._footer.visible = this._pickerButton.visible ||
            this._volumeBox.visible || this._outputButton.visible;
    }

    /* The lists float over the card, so opening one never makes the card
     * taller or pushes it off screen. */
    _buildPopups() {
        /* Dims the card and takes the dismissing click, so it does not also
         * land on a control underneath. It covers the footer's buttons too,
         * so only one list is ever open. */
        this._scrim = new St.Button({
            style_class: 'mc-card-scrim',
            x_expand: true,
            y_expand: true,
            opacity: 0,
            visible: false,
        });
        this._scrim.connect('clicked', () => this._closePopup());
        this.add_child(this._scrim);

        this._playerList = new PlayerList(this._artCache);
        this._playerList.connect('player-selected', (_list, busName) => {
            this._closePopup();
            this.emit('player-selected', busName);
        });
        this._playerPopup = this._addPopup(this._playerList,
            this._pickerButton, this._pickerArrow);

        this._outputList = new OutputList();
        this._outputList.connect('output-selected', (_list, id) => {
            this._closePopup();
            this.emit('output-selected', id);
        });
        this._outputPopup = this._addPopup(this._outputList, this._outputButton, null);
    }

    /* arrow, if any, turns over while the list is open. */
    _addPopup(list, button, arrow) {
        list.opacity = 0;
        list.connect('close-requested', () => this._closePopup());

        /* Placed by the layer, not margins, which St resets from the stylesheet
         * on every style change. The layer is not reactive, so a click beside
         * the list reaches the scrim. */
        const layer = new ListLayer(list, () => this._topOf(button));
        this.add_child(layer);
        return {list, layer, button, arrow};
    }

    /* An actor's top, in card coordinates. The content is allocated before
     * the list layers ask, so the allocations are current. */
    _topOf(widget) {
        let y = 0;
        for (let actor = widget; actor && actor !== this; actor = actor.get_parent())
            y += actor.get_allocation_box().y1;
        return y;
    }

    _togglePopup(popup) {
        if (this._popup === popup) {
            this._closePopup();
            return;
        }
        /* From the keyboard, focus goes into the list; with the pointer, no
         * row should light up as if focused. */
        const type = Clutter.get_current_event()?.type();
        this._openPopup(popup, type === Clutter.EventType.KEY_PRESS ||
            type === Clutter.EventType.KEY_RELEASE);
    }

    _openPopup(popup, byKeyboard) {
        if (this._popup)
            return;
        this._popup = popup;
        this._focusBeforePopup = global.stage.key_focus;

        const {list, layer, button, arrow} = popup;
        list.open();
        list.remove_all_transitions();
        layer.show();

        const mode = Clutter.AnimationMode.EASE_OUT_QUAD;
        this._scrim.remove_all_transitions();
        this._scrim.show();
        this._scrim.ease({opacity: 255, duration: LIST_MS, mode});
        list.translation_y = LIST_SLIDE;
        list.ease({opacity: 255, translation_y: 0, duration: LIST_MS, mode});
        arrow?.ease({rotation_angle_z: 180, duration: LIST_MS, mode});
        button.checked = true;

        if (byKeyboard)
            list.focusActive();
        else
            list.grab_key_focus();
    }

    /* animate is false when the card itself is going away. */
    _closePopup(animate = true) {
        const popup = this._popup;
        if (!popup)
            return;
        this._popup = null;

        const {list, layer, button, arrow} = popup;

        /* Focus goes back where it was, not left in a list about to hide. */
        const focus = global.stage.key_focus;
        if (focus && list.contains(focus))
            (this._focusBeforePopup ?? button).grab_key_focus();
        this._focusBeforePopup = null;

        list.close();
        button.checked = false;

        const duration = animate ? LIST_MS : 0;
        const mode = Clutter.AnimationMode.EASE_OUT_QUAD;
        arrow?.ease({rotation_angle_z: 0, duration, mode});
        this._scrim.ease({
            opacity: 0,
            duration,
            mode,
            onComplete: () => this._scrim.hide(),
        });
        list.ease({
            opacity: 0,
            translation_y: LIST_SLIDE / 2,
            duration,
            mode,
            onComplete: () => layer.hide(),
        });
    }

    /* The player's own volume, not the system's: over MPRIS where the player
     * takes it, and for a browser, which does not, its sound streams' volume.
     * Both announce changes, so unlike the seek bar it needs no polling. */
    _buildVolume() {
        this._volumeBox = new St.BoxLayout({
            style_class: 'mc-volume-box',
            ...boxOrientation(Clutter.Orientation.HORIZONTAL),
            x_expand: true,
        });

        this._volumeIcon = new St.Icon({
            style_class: 'mc-volume-icon',
            icon_name: volumeIconName(1),
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._volumeSlider = new Slider(0);
        this._volumeSlider.add_style_class_name('mc-volume');
        this._volumeSlider.x_expand = true;
        this._volumeSlider.accessible_name = _('Volume');

        /* Drags, scrolls, clicks and arrow keys all land here. Blocked while
         * _syncVolume() moves the slider, so the player's value is not written
         * straight back. */
        this._volumeChangedId = this._volumeSlider.connect('notify::value', () => {
            const volume = this._volumeSlider.value;
            /* Held before writing: a stream announces its new volume during
             * the write, and moving the slider from inside this handler would
             * have GLib replay the change once the block is lifted. */
            this._holdVolume();
            if (this._player?.canSetVolume)
                this._player.setVolume(volume);
            else
                this._streamVolume.setLevel(volume);
            this._volumeIcon.icon_name = volumeIconName(volume);
        });

        this._volumeBox.add_child(this._volumeIcon);
        this._volumeBox.add_child(this._volumeSlider);
    }

    /* Keep the user's value until the writes have echoed back, then take the
     * player's, which also corrects a clamped or refused change. */
    _holdVolume() {
        if (this._volumeHoldId)
            GLib.Source.remove(this._volumeHoldId);
        this._volumeHoldId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            VOLUME_HOLD_MS, () => {
                this._volumeHoldId = 0;
                this._syncVolume();
                return GLib.SOURCE_REMOVE;
            });
    }

    /* A browser with no stream open shows the level its app last had, dimmed.
     * Never having seen one, it shows full: the level the sound server gives
     * an app it has no volume for. */
    _syncVolume() {
        const player = this._player;
        if (!player)
            return;

        const live = player.canSetVolume ? player.volume : this._streamVolume.level;
        this._setVolumeLive(live !== null);

        const volume = live ?? this._streamVolume.lastLevel ?? 1;
        if (this._volumeHoldId)
            return;
        this._volumeSlider.block_signal_handler(this._volumeChangedId);
        this._volumeSlider.value = volume;
        this._volumeSlider.unblock_signal_handler(this._volumeChangedId);
        this._volumeIcon.icon_name = volumeIconName(volume);
    }

    _setVolumeLive(live) {
        this._volumeSlider.can_focus = live;
        setReactive(this._volumeSlider, live);
        this._volumeBox.opacity = live ? 255 : VOLUME_IDLE_OPACITY;
    }

    _toggleShuffle() {
        if (!this._player)
            return;
        this._player.setShuffle(!this._player.shuffle);
        this.sync();
    }

    _cycleLoop() {
        if (!this._player)
            return;
        this._player.setLoopStatus(nextLoopStatus(this._player.loopStatus));
        this.sync();
    }

    _skip(direction) {
        if (!this._player)
            return;
        this._player.seek(seekOffset(this._settings, direction));

        /* For players that do not emit Seeked; there is no poll while paused. */
        this._refreshPositionSoon();
    }

    _refreshPositionSoon() {
        if (this._seekRefreshId)
            GLib.Source.remove(this._seekRefreshId);
        this._seekRefreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._seekRefreshId = 0;
            this._refreshPosition();
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyWidth() {
        this.style = `width: ${this._settings.get_int('card-width')}px;`;
    }

    /* height is the most the card may take, in stage pixels. */
    setMaxHeight(height) {
        this._maxHeight = height;
        this._applyLyricsHeight();
    }

    /* The lyrics get the setting's height, short of running the card off
     * screen: whatever room the rest of the card leaves. */
    _applyLyricsHeight() {
        const [, card] = this.get_preferred_height(this.width);
        const [, lyrics] = this._lyrics.visible ? this._lyrics.get_preferred_height(-1) : [0, 0];
        this._lyrics.setHeight(this._settings.get_int('lyrics-height'),
            this._maxHeight - (card - lyrics));
    }

    /* Size and background-image share one `style` property, so they are always
     * written together. */
    _applyArtSize() {
        const nick = this._settings.get_string('card-art-size');
        this._artSize = ART_SIZES[nick] ?? ART_SIZES[DEFAULT_ART_SIZE];
        this._artFallback.icon_size = this._artSize.icon;
        this._applyArtStyle();
    }

    _applyArtStyle() {
        const {size, radius} = this._artSize;
        const image = this._artPath
            ? ` background-image: ${cssUrl(this._artPath)};`
            : '';
        this._artButton.style =
            `width: ${size}px; height: ${size}px; border-radius: ${radius}px;${image}`;
    }

    /* Called on every change of the player on screen, which keeps the card
     * current; the card does not also listen for the player's 'changed', which
     * would render each change twice. */
    setPlayer(player) {
        if (this._player === player) {
            this.sync();
            return;
        }

        this._disconnectPlayer();
        this._player = player;

        if (player) {
            this._playerSignals.push(player.connect('seeked', (_p, position) => {
                this._position = position;
                this._updateSlider();
                this._lyrics.setPosition(position);
            }));
        }

        this._currentArtUrl = null;
        this.sync();
        this._refreshPosition();
    }

    _disconnectPlayer() {
        if (this._player) {
            for (const id of this._playerSignals)
                this._player.disconnect(id);
        }
        this._playerSignals = [];
    }

    /* Whether the card is on screen; animations and polling run only then. */
    setActive(active) {
        this._active = active;
        /* The card opens as it was left, apart from the lists. */
        if (!active)
            this._closePopup(false);
        this._equalizer.setActive(active);
        this._lyrics.setActive(active);
        this._updateTimer();
        if (active)
            this._refreshPosition();
    }

    /* Polling moves the seek bar and timed lyrics; with neither on screen there
     * is none, since every tick is a D-Bus round trip. */
    _updateTimer() {
        const wanted = this._active && this._player?.isPlaying &&
            (this._seekBox.visible || this._lyrics.wantsPosition);

        if (wanted && !this._timeoutId) {
            this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
                POSITION_POLL_SECONDS, () => {
                    this._refreshPosition();
                    return GLib.SOURCE_CONTINUE;
                });
        } else if (!wanted && this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    _refreshPosition() {
        const player = this._player;
        if (!player)
            return;
        player.getPosition().then(position => {
            /* The round trip can outlive a drag starting, the player it was
             * for, or the card (destroy nulls `_player`). A failed read keeps
             * the last position rather than snapping to 0. */
            if (position === null || this._dragging || this._player !== player)
                return;
            this._position = position;
            this._updateSlider();
            this._lyrics.setPosition(position);
        });
    }

    _updateSlider() {
        if (this._dragging)
            return;
        const fraction = this._length > 0
            ? Math.min(1, Math.max(0, this._position / this._length))
            : 0;
        this._slider.value = fraction;
        this._updateTimeLabels(this._position);
    }

    _updateTimeLabels(position, length = this._length) {
        this._positionLabel.text = formatTime(position);
        this._remainingLabel.text = `-${formatTime(Math.max(0, length - position))}`;
    }

    /* Drop any painted art and orphan the download in flight. */
    _clearArt() {
        this._artGeneration++;
        this._currentArtUrl = null;
        this._artPath = null;
        this._applyArtStyle();
        this._artFallback.gicon = null;
        this._artFallback.icon_name = 'audio-x-generic-symbolic';
        this._artFallback.opacity = DIM_OPACITY;
        this._artFallback.visible = true;
    }

    /* A real app icon reads as artwork; only the generic placeholder is
     * dimmed. */
    _setFallbackIcon(player) {
        this._artFallback.gicon = player.appIcon;
        this._artFallback.opacity = player.hasAppIcon ? 255 : DIM_OPACITY;
    }

    _updateArt() {
        const player = this._player;
        const showArt = this._settings.get_boolean('card-show-art');
        this._artButton.visible = showArt;

        /* Forget the art while nothing uses it, so re-enabling a setting on the
         * same track resolves it again. The backdrop needs the art even while
         * the artwork itself is hidden. */
        if (!(showArt || this._settings.get_boolean('card-art-backdrop')) || !player) {
            this._clearArt();
            this._dropBackdrop();
            return;
        }

        const url = player.artUrl;
        if (url === this._currentArtUrl) {
            /* The app proxy lands after the player proxy, so a track with no
             * artwork can still gain a real icon on a later sync. */
            if (this._artFallback.visible)
                this._setFallbackIcon(player);
            return;
        }

        /* A newer track must win even if its download finishes first. */
        this._clearArt();
        this._currentArtUrl = url;
        const generation = this._artGeneration;
        this._setFallbackIcon(player);

        /* The last track's backdrop stays until the new art is in, rather than
         * flashing the plain card; only a track known to have none drops it. */
        if (!url) {
            this._dropBackdrop();
            return;
        }

        this._artCache.resolve(url).then(path => {
            if (generation !== this._artGeneration)
                return;
            if (!path) {
                this._dropBackdrop();
                return;
            }
            this._artPath = path;
            this._applyArtStyle();
            this._artFallback.visible = false;
            this._updateBackdrop();
        });
    }

    sync() {
        const player = this._player;

        if (!player) {
            this._titleLabel.text = _('Nothing playing');
            this._artistLabel.text = '';
            this._artistLabel.visible = false;
            this._albumLabel.text = '';
            this._albumLabel.visible = false;
            this._seekBox.visible = false;
            this._setRaisable(false);
            this._backButton.visible = false;
            this._forwardButton.visible = false;
            this._shuffleButton.visible = false;
            this._loopButton.visible = false;
            this._volumeBox.visible = false;
            this._streamVolume.setPlayer(null);
            this._updateFooter();
            this._equalizer.visible = false;
            this._equalizer.setPlaying(false);
            this._lyricsButton.visible = false;
            this._lyrics.update(null);
            this._length = 0;
            this._updateArt();
            this._updateTimer();
            return;
        }

        const title = player.displayTitle || _('Unknown title');
        const artist = player.artist;
        const album = player.album;

        this._titleLabel.text = truncate(title, MAX_TITLE_CHARS);
        const showAlbum = !!album && album !== artist && album !== title;
        this._artistLabel.text = artist || '';
        this._artistLabel.visible = !!artist;
        this._albumLabel.text = showAlbum ? album : '';
        this._albumLabel.visible = showAlbum;

        this._playButton.child.icon_name = playPauseIconName(player);

        this._equalizer.visible = true;
        this._equalizer.setPlaying(player.isPlaying);

        this._setSensitive(this._prevButton, player.canGoPrevious);
        this._setSensitive(this._nextButton, player.canGoNext);
        this._setSensitive(this._playButton, player.canPlay);

        this._setRaisable(player.canRaise, player.displayName);

        this._length = player.length;
        const showSeek = this._settings.get_boolean('card-show-seek-bar') &&
            this._length > 0;
        this._seekBox.visible = showSeek;
        this._setSensitive(this._slider, player.canSeek);

        /* Skip buttons need Seek(). */
        const showSkip = this._settings.get_boolean('card-show-seek-buttons') &&
            player.canSeek;
        this._backButton.visible = showSkip;
        this._forwardButton.visible = showSkip;

        /* Shuffle and loop are optional in MPRIS: no support, no button. */
        this._shuffleButton.visible =
            this._settings.get_boolean('card-show-shuffle') && player.canShuffle;
        this._loopButton.visible =
            this._settings.get_boolean('card-show-loop') && player.canLoop;
        this._loopButton.child.icon_name = loopIconName(player.loopStatus);
        setToggleStyle(this._shuffleButton, player.shuffle === true);
        setToggleStyle(this._loopButton,
            player.canLoop && player.loopStatus !== 'None');

        /* Browsers take no volume over MPRIS; their sound streams stand in. */
        const streams = !player.canSetVolume && player.kind === PlayerKind.BROWSER;
        this._volumeBox.visible = this._settings.get_boolean('card-show-volume') &&
            (player.canSetVolume || streams);
        this._streamVolume.setPlayer(streams && this._volumeBox.visible ? player : null);
        this._syncVolume();
        this._updateFooter();

        /* Lyrics are for songs, not browser tabs or films. */
        const showLyrics = this._settings.get_boolean('card-show-lyrics-button') &&
            player.playsMusic;
        this._lyricsButton.visible = showLyrics;
        this._lyrics.update(showLyrics ? player : null);

        this._updateArt();
        this._updateSlider();
        this._updateTimer();
        /* A title that wraps onto another line leaves the lyrics less room. */
        if (this._active)
            this._applyLyricsHeight();
    }

    /* `reactive` alone is enough: St maps it to `:insensitive`, which the
     * theme styles. */
    _setSensitive(actor, sensitive) {
        setReactive(actor, sensitive);
    }

    /* The artwork acts as a button only for a player that implements Raise;
     * otherwise it is a picture, with no hover cue and nothing to tab to. name
     * labels it for screen readers. */
    _setRaisable(raisable, name = '') {
        if (this._artButton.reactive !== raisable) {
            this._artButton.can_focus = raisable;
            this._artButton.track_hover = raisable;
            setReactive(this._artButton, raisable);
            syncHover(this._artButton);
        }
        this._artButton.accessible_name = raisable ? name : '';
    }

    _onDestroy() {
        /* Orphans any in-flight art download or backdrop: their callbacks find
         * the generation stale. */
        this._artGeneration++;
        this._backdropGeneration++;
        this._backdropMaker.destroy();

        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._seekRefreshId) {
            GLib.Source.remove(this._seekRefreshId);
            this._seekRefreshId = 0;
        }
        if (this._volumeHoldId) {
            GLib.Source.remove(this._volumeHoldId);
            this._volumeHoldId = 0;
        }
        this._disconnectPlayer();
        this._streamVolume.destroy();
        for (const id of this._settingsSignals)
            this._settings.disconnect(id);
        this._settingsSignals = [];
        this._player = null;
        this._players = [];
        this._activePlayer = null;
        this._focusBeforePopup = null;
    }
});
