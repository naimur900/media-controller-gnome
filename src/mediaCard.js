// SPDX-License-Identifier: GPL-2.0-or-later
/* mediaCard.js
 *
 * The iOS-style "now playing" card shown when the panel indicator is clicked.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { Slider } from 'resource:///org/gnome/shell/ui/slider.js';

import { Equalizer } from './equalizer.js';
import {
    US_PER_SECOND, loopIconName, nextLoopStatus, playPauseIconName,
    seekOffset, setToggleStyle
} from './transport.js';

const POSITION_POLL_SECONDS = 1;

/* A wrapping title has no natural bound: the card is as tall as the text needs.
 * Podcast episodes and DJ sets routinely carry titles of a few hundred
 * characters, which would push the controls off the bottom of the screen. This
 * caps the title at roughly three lines at the default card width; the wrap
 * still does the real work, this only stops the pathological case. */
const MAX_TITLE_CHARS = 120;

/* How many player icons the switcher draws before collapsing the rest into a
 * "+N" button. Three keeps the row a glanceable strip: a session with more
 * players than that is one where the row would otherwise become the loudest
 * thing on the card. */
const MAX_VISIBLE_TABS = 3;

/* Keyed by the `card-art-size` enum nick. `icon` sizes the fallback player icon
 * so it keeps roughly the same inset as the artwork it stands in for, and the
 * radius tracks the size so the corners stay proportionally round. */
const ART_SIZES = {
    'small': {size: 64, radius: 12, icon: 28},
    'medium': {size: 88, radius: 16, icon: 40},
    'large': {size: 120, radius: 20, icon: 56},
};
const DEFAULT_ART_SIZE = 'medium';

/**
 * Spreading the string iterates code points, so the cut never lands between the
 * halves of a surrogate pair and split an emoji into a broken glyph.
 *
 * @param {string} text @param {number} maxLength
 */
function truncate(text, maxLength) {
    const chars = [...text];
    if (chars.length <= maxLength)
        return text;
    return `${chars.slice(0, maxLength - 1).join('').trimEnd()}…`;
}

/** Hours only appear once there are some: `4:07`, but `1:23:20`. */
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

/** St parses this as CSS, so a path with a quote in it must not break out. */
function cssUrl(path) {
    return `url("${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`;
}

/* Secondary text; opacity keeps it legible in both light and dark themes,
 * which a hardcoded color would not. */
const DIM_OPACITY = 160;

/* `message-media-control` is the shell's own media button style, so hover,
 * active and insensitive states follow the current theme. */
function iconButton(iconName, styleClass) {
    return new St.Button({
        style_class: `message-media-control ${styleClass}`,
        can_focus: true,
        child: new St.Icon({icon_name: iconName}),
    });
}

export const MediaCard = GObject.registerClass({
    Signals: {
        /* Raised the player's window; the menu should close. */
        'activated': {},
        /* The gear button was pressed. */
        'open-preferences': {},
        /* A switcher tab was pressed; carries the player's MPRIS bus name. */
        'player-selected': {param_types: [GObject.TYPE_STRING]},
    },
}, class MediaCard extends St.BoxLayout {
    _init(artCache, settings) {
        super._init({
            style_class: 'mc-card',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        this._artCache = artCache;
        this._settings = settings;
        this._player = null;
        this._playerSignals = [];
        this._timeoutId = 0;
        this._seekRefreshId = 0;
        this._dragging = false;
        this._dragPlayer = null;
        this._dragLength = 0;
        this._active = false;
        this._currentArtUrl = null;
        this._artGeneration = 0;
        this._artPath = null;
        this._artSize = ART_SIZES[DEFAULT_ART_SIZE];
        this._length = 0;
        this._position = 0;
        this._roster = [];
        this._tabs = new Map();
        this._tabsKey = null;
        this._activeBusName = null;
        this._expanded = false;

        this._buildSwitcher();
        this._buildHeader();
        this._buildSeekBar();
        this._buildControls();

        this._settingsSignals = [
            this._settings.connect('changed::card-show-art', () => this.sync()),
            this._settings.connect('changed::card-show-seek-bar', () => this.sync()),
            this._settings.connect('changed::card-show-seek-buttons', () => this.sync()),
            this._settings.connect('changed::card-show-shuffle', () => this.sync()),
            this._settings.connect('changed::card-show-loop', () => this.sync()),
            this._settings.connect('changed::card-show-player-switcher',
                () => this._updateSwitcher()),
            this._settings.connect('changed::card-width', () => this._applyWidth()),
            this._settings.connect('changed::card-art-size', () => this._applyArtSize()),
        ];
        this._applyWidth();
        this._applyArtSize();

        this.connect('destroy', () => this._onDestroy());
    }

    /* One tab per running player, on a row of its own along the top of the
     * card. Nothing else shares that row: the header below it then spans the
     * full width, which is what keeps a long title out of a narrow column.
     * Hidden — and left empty — whenever there is nothing to switch between,
     * which is the usual case, so the card pays nothing for the feature until a
     * second player shows up. */
    _buildSwitcher() {
        this._switcherBox = new St.BoxLayout({
            style_class: 'mc-player-tabs',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_align: Clutter.ActorAlign.END,
            visible: false,
        });
        this.add_child(this._switcherBox);
    }

    /**
     * Hand the card the players it can switch between. Called on every sync, so
     * it does as little as possible when nothing has moved.
     *
     * @param {object[]} players the players to offer, in a stable order
     * @param {object|null} active the one currently on screen
     */
    setPlayers(players, active) {
        this._roster = players;
        this._activeBusName = active?.busName ?? null;
        this._updateSwitcher();
    }

    _updateSwitcher() {
        const players = this._roster;
        /* One player is not a choice, and zero is the idle card. */
        const show = players.length > 1 &&
            this._settings.get_boolean('card-show-player-switcher');

        this._switcherBox.visible = show;
        if (!show) {
            this._clearTabs();
            return;
        }

        const visible = this._visibleTabs(players);
        const overflow = players.length - visible.length;

        /* Rebuilding drops keyboard focus and restarts the button's hover
         * transitions, so it happens only when the row itself changes — not on
         * every metadata update from the player that is playing. */
        const key = `${visible.map(player => player.busName).join('\n')}|${overflow}`;
        if (key !== this._tabsKey)
            this._rebuildTabs(visible, overflow, key);

        for (const player of visible) {
            const tab = this._tabs.get(player.busName);
            if (!tab)
                continue;

            /* Both of these resolve asynchronously with the app proxy, so a tab
             * built a moment ago may still be showing a generic icon and no
             * name at all. The name is the tab's only label — nothing is drawn
             * beside the icon — so it also carries the accessible name. */
            tab.icon.gicon = player.appIcon;
            tab.button.accessible_name = player.identity;

            /* The one on screen is fully lit; the others recede. */
            const isActive = player.busName === this._activeBusName;
            tab.icon.opacity = isActive ? 255 : DIM_OPACITY;
            if (isActive !== tab.button.has_style_class_name('mc-player-tab-active')) {
                if (isActive)
                    tab.button.add_style_class_name('mc-player-tab-active');
                else
                    tab.button.remove_style_class_name('mc-player-tab-active');
            }
        }
    }

    /**
     * At most MAX_VISIBLE_TABS icons; the rest are counted by the overflow
     * button, which shows them all when pressed. The player on screen is always
     * among them — the row reports which player the card is following, so
     * leaving that one out is the one thing it must never do.
     *
     * @param {object[]} players every player the switcher was given
     * @returns {object[]} the ones to draw an icon for
     */
    _visibleTabs(players) {
        if (this._expanded || players.length <= MAX_VISIBLE_TABS)
            return players;

        const visible = players.slice(0, MAX_VISIBLE_TABS);
        if (visible.some(player => player.busName === this._activeBusName))
            return visible;

        /* The active player is further down the list: it takes the last slot,
         * so the ones before it keep their places. */
        const active = players.find(player => player.busName === this._activeBusName);
        if (active)
            visible[MAX_VISIBLE_TABS - 1] = active;
        return visible;
    }

    _rebuildTabs(players, overflow, key) {
        this._clearTabs();
        this._tabsKey = key;

        for (const player of players) {
            /* Icons only: names would make each tab as wide as the player is
             * called, and the row is meant to stay a strip rather than become a
             * list. The identity goes on the button as its accessible name. */
            const icon = new St.Icon({icon_size: 16});
            const button = new St.Button({
                style_class: 'mc-player-tab',
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
                child: icon,
            });

            /* The bus name, not the player object: by the time this fires the
             * player may have quit, and the manager is the one that knows. */
            const {busName} = player;
            button.connect('clicked', () => this.emit('player-selected', busName));

            this._switcherBox.add_child(button);
            this._tabs.set(busName, {button, icon});
        }

        if (overflow > 0)
            this._switcherBox.add_child(this._moreButton(overflow));
    }

    /**
     * The tail of the list, collapsed into one pill: "+3". Pressing it shows
     * every player until the card closes, which is the only way to reach the
     * ones the cap left out.
     *
     * @param {number} overflow how many players are not shown
     * @returns {object} the St.Button to append
     */
    _moreButton(overflow) {
        const label = new St.Label({
            style_class: 'mc-player-tab-more-label',
            text: `+${overflow}`,
            y_align: Clutter.ActorAlign.CENTER,
            opacity: DIM_OPACITY,
        });
        const button = new St.Button({
            style_class: 'mc-player-tab mc-player-tab-more',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: label,
        });
        button.accessible_name = _('Show all players');
        button.connect('clicked', () => {
            this._expanded = true;
            this._updateSwitcher();
        });
        return button;
    }

    /* Counts children rather than tabs: the overflow button is one too. */
    _clearTabs() {
        if (this._switcherBox.get_n_children() === 0)
            return;
        this._switcherBox.destroy_all_children();
        this._tabs.clear();
        this._tabsKey = null;
    }

    _buildHeader() {
        const header = new St.BoxLayout({
            style_class: 'mc-card-header',
            orientation: Clutter.Orientation.HORIZONTAL,
        });

        /* The artwork is the card's "go to the app" target: clicking it raises
         * the player's window. A button rather than a bin, so hover and focus
         * come from the theme — St.Button is itself a St.Bin, so it still takes
         * the fallback icon as its child and the sizing style as its own. */
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
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this._titleLabel = new St.Label({style_class: 'mc-card-title', text: _('Nothing playing')});
        this._artistLabel = new St.Label({style_class: 'mc-card-artist', text: ''});
        this._albumLabel = new St.Label({style_class: 'mc-card-album', text: ''});
        /* The card has a fixed width, so a long title wraps onto further lines
         * rather than being cut off. Breaking mid-word is the fallback for a
         * single word too long to fit on a line of its own. */
        this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._titleLabel.clutter_text.line_wrap = true;
        this._titleLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._artistLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._albumLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        textBox.add_child(this._titleLabel);
        textBox.add_child(this._artistLabel);
        textBox.add_child(this._albumLabel);
        header.add_child(textBox);

        /* A full-height column down the right edge: the gear pinned to the top
         * corner, and the equalizer centred against the art. */
        const actions = new St.BoxLayout({
            style_class: 'mc-card-actions',
            orientation: Clutter.Orientation.VERTICAL,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
        });

        this._prefsButton = new St.Button({
            style_class: 'mc-app-button',
            can_focus: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            child: new St.Icon({icon_name: 'emblem-system-symbolic', icon_size: 16}),
        });
        this._prefsButton.connect('clicked', () => this.emit('open-preferences'));
        actions.add_child(this._prefsButton);

        /* Expanding is what pushes this off the gear and centres it. */
        const status = new St.BoxLayout({
            style_class: 'mc-card-status',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
        });

        this._equalizer = new Equalizer();
        status.add_child(this._equalizer);
        actions.add_child(status);

        header.add_child(actions);
        this.add_child(header);
    }

    _buildSeekBar() {
        this._seekBox = new St.BoxLayout({
            style_class: 'mc-seek-box',
            orientation: Clutter.Orientation.VERTICAL,
        });

        this._slider = new Slider(0);
        this._slider.add_style_class_name('mc-seek');
        this._slider.x_expand = true;

        /* The track can advance while the thumb is held, and sync() would move
         * `_length` out from under the drag. Pin the player and the duration the
         * user is actually scrubbing against. */
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
        /* Keep the timestamps under the thumb while the user scrubs. */
        this._slider.connect('notify::value', () => {
            if (this._dragging && this._dragLength > 0) {
                this._updateTimeLabels(this._slider.value * this._dragLength,
                    this._dragLength);
            }
        });

        const times = new St.BoxLayout({
            style_class: 'mc-time-box',
            orientation: Clutter.Orientation.HORIZONTAL,
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
        this.add_child(this._seekBox);
    }

    _buildControls() {
        /* A box, not a BinLayout stack: shuffle packs against the left edge,
         * loop against the right, and the expanding transport cluster centres
         * itself in the space between them. (A BinLayout overlay does not
         * apply the edge buttons' alignment and piles them onto the middle of
         * the row, underneath the play button.) */
        const row = new St.BoxLayout({
            style_class: 'mc-controls-row',
            orientation: Clutter.Orientation.HORIZONTAL,
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
            orientation: Clutter.Orientation.HORIZONTAL,
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
        this.add_child(row);
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

    /**
     * @param {number} direction -1 to rewind, 1 to skip ahead
     */
    _skip(direction) {
        if (!this._player)
            return;
        this._player.seek(seekOffset(this._settings, direction));

        /* Players that do not emit Seeked would otherwise leave the slider
         * stale until the next poll — and there is no poll while paused. */
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

    /* The art bin's geometry and its background-image share one `style`
     * property, so both are written together rather than clobbering each other. */
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

    setPlayer(player) {
        if (this._player === player) {
            this.sync();
            return;
        }

        this._disconnectPlayer();
        this._player = player;

        if (player) {
            this._playerSignals.push(player.connect('changed', () => this.sync()));
            this._playerSignals.push(player.connect('seeked', (_p, position) => {
                this._position = position;
                this._updateSlider();
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

    /** The card only polls Position while it is actually on screen. */
    setActive(active) {
        this._active = active;
        this._equalizer.setActive(active);
        this._updateTimer();

        if (active) {
            this._refreshPosition();
            return;
        }

        /* Closing the card collapses an expanded switcher, so it opens at its
         * usual size next time rather than however it was left. */
        if (this._expanded) {
            this._expanded = false;
            this._updateSwitcher();
        }
    }

    /* Polling exists to move the seek bar. No seek bar on screen, no polling —
     * every tick is a D-Bus round trip. */
    _updateTimer() {
        const wanted = this._active && this._seekBox.visible &&
            this._player?.isPlaying;

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
            /* The D-Bus round trip can outlive a drag starting, the player it
             * was issued for, or the card itself (destroy nulls `_player`) — a
             * late answer from the previous track would otherwise be painted
             * onto this one's slider. */
            if (this._dragging || this._player !== player)
                return;
            this._position = position;
            this._updateSlider();
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

    /** Drop any painted art and orphan whatever download is in flight. */
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

    /* A real app icon carries its own color and reads as artwork; only the
     * generic symbolic placeholder wants dimming. */
    _setFallbackIcon(player) {
        this._artFallback.gicon = player.appIcon;
        this._artFallback.opacity = player.hasAppIcon ? 255 : DIM_OPACITY;
    }

    _updateArt() {
        const player = this._player;
        const showArt = this._settings.get_boolean('card-show-art');
        this._artButton.visible = showArt;

        /* Forget the current art while hidden, so re-enabling the setting on the
         * same track resolves it again instead of short-circuiting below. */
        if (!showArt || !player) {
            this._clearArt();
            return;
        }

        const url = player.artUrl;
        if (url === this._currentArtUrl) {
            /* The app proxy resolves after the player proxy, so a track with no
             * artwork can still gain a real icon on a later sync. */
            if (this._artFallback.visible)
                this._setFallbackIcon(player);
            return;
        }

        /* Art resolution is async; a newer track must win even if its download
         * finishes first. */
        this._clearArt();
        this._currentArtUrl = url;
        const generation = this._artGeneration;
        this._setFallbackIcon(player);

        if (!url)
            return;

        this._artCache.resolve(url).then(path => {
            if (generation !== this._artGeneration || !path)
                return;
            this._artPath = path;
            this._applyArtStyle();
            this._artFallback.visible = false;
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
            this._equalizer.visible = false;
            this._equalizer.setPlaying(false);
            this._length = 0;
            this._updateArt();
            this._updateTimer();
            return;
        }

        const title = player.title || _('Unknown title');
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

        this._setRaisable(player.canRaise, player.identity);

        this._length = player.length;
        const showSeek = this._settings.get_boolean('card-show-seek-bar') &&
            this._length > 0;
        this._seekBox.visible = showSeek;
        this._setSensitive(this._slider, player.canSeek);

        /* Skipping needs Seek(); a player without it gets no skip buttons. */
        const showSkip = this._settings.get_boolean('card-show-seek-buttons') &&
            player.canSeek;
        this._backButton.visible = showSkip;
        this._forwardButton.visible = showSkip;

        /* Shuffle and loop are optional MPRIS properties; a player that does
         * not implement them gets no button, whatever the setting says. */
        this._shuffleButton.visible =
            this._settings.get_boolean('card-show-shuffle') && player.canShuffle;
        this._loopButton.visible =
            this._settings.get_boolean('card-show-loop') && player.canLoop;
        this._loopButton.child.icon_name = loopIconName(player.loopStatus);
        setToggleStyle(this._shuffleButton, player.shuffle === true);
        setToggleStyle(this._loopButton,
            player.canLoop && player.loopStatus !== 'None');

        this._updateArt();
        this._updateSlider();
        this._updateTimer();
    }

    /* Setting `reactive` is enough: St maps it to the `:insensitive` pseudo
     * class, which the theme already styles. */
    _setSensitive(actor, sensitive) {
        actor.reactive = sensitive;
    }

    /**
     * The artwork only behaves like a button for a player that can actually be
     * raised; for the rest it goes back to being a picture, with no hover cue
     * and nothing to tab to.
     *
     * @param {boolean} raisable whether the player implements Raise
     * @param {string} identity names the target for screen readers
     */
    _setRaisable(raisable, identity = '') {
        this._artButton.reactive = raisable;
        this._artButton.can_focus = raisable;
        this._artButton.track_hover = raisable;
        this._artButton.accessible_name = raisable ? identity : '';
    }

    _onDestroy() {
        /* Orphans any in-flight art download: its callback checks the
         * generation and finds it stale. */
        this._artGeneration++;

        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._seekRefreshId) {
            GLib.Source.remove(this._seekRefreshId);
            this._seekRefreshId = 0;
        }
        this._disconnectPlayer();
        for (const id of this._settingsSignals)
            this._settings.disconnect(id);
        this._settingsSignals = [];
        this._player = null;
        /* The tab actors go with the card; these only hold player references. */
        this._tabs.clear();
        this._roster = [];
    }
});
