// SPDX-License-Identifier: GPL-2.0-or-later
/* prefs.js: the preferences window. Runs in its own process, not the shell. */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from
    'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {artCacheDir} from './paths.js';

/* Batches keep a large cache from blocking the main loop. */
const ENUMERATE_BATCH = 64;

/* Index order must match the enum nicks in the GSettings schema. */
const POSITIONS = ['far-left', 'left', 'center', 'right', 'far-right'];
const DIRECTIONS = ['left-to-right', 'right-to-left'];
const ART_SIZES = ['small', 'medium', 'large'];

/* Functions, not constants: gettext finds the extension from the call stack,
 * and none is registered yet at module scope. */
function positionLabels() {
    return [
        _('Far left'),
        _('Left'),
        _('Center'),
        _('Right'),
        _('Far right'),
    ];
}

function directionLabels() {
    return [
        _('Left to right'),
        _('Right to left'),
    ];
}

function artSizeLabels() {
    return [
        _('Small'),
        _('Medium'),
        _('Large'),
    ];
}

export default class MediaControlsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(620, 720);

        window.add(this._panelPage(settings));
        window.add(this._cardPage(settings));
        window.add(this._maintenancePage(settings, window));
    }

    _switchRow(settings, key, title, subtitle = null) {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    /* Adw.ComboRow cannot bind a GSettings enum, so nick and index are synced
     * by hand both ways. */
    _comboRow(settings, key, title, nicks, labels) {
        const row = new Adw.ComboRow({title, model: Gtk.StringList.new(labels)});
        row.selected = Math.max(0, nicks.indexOf(settings.get_string(key)));
        row.connect('notify::selected', () =>
            settings.set_string(key, nicks[row.selected]));
        /* Follow changes made elsewhere, e.g. in dconf. */
        settings.connect(`changed::${key}`, () => {
            const index = nicks.indexOf(settings.get_string(key));
            if (index >= 0 && index !== row.selected)
                row.selected = index;
        });
        return row;
    }

    _spinRow(settings, key, title, subtitle, min, max, step) {
        const row = new Adw.SpinRow({
            title,
            subtitle,
            adjustment: new Gtk.Adjustment({
                lower: min,
                upper: max,
                step_increment: step,
                page_increment: step * 5,
            }),
        });
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    /* Grey a row out while the feature it configures is switched off. */
    _bindSensitive(settings, key, row) {
        settings.bind(key, row, 'sensitive', Gio.SettingsBindFlags.GET);
        return row;
    }

    _panelPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Panel'),
            icon_name: 'user-home-symbolic',
        });

        const placement = new Adw.PreferencesGroup({
            title: _('Placement'),
            description: _('Where the indicator appears in the top panel.'),
        });
        placement.add(this._comboRow(settings, 'panel-position', _('Position'),
            POSITIONS, positionLabels()));
        placement.add(this._switchRow(settings, 'controls-on-left',
            _('Show controls before track information'),
            _('Place the playback buttons to the left of the player icon and text.')));
        placement.add(this._switchRow(settings, 'hide-when-inactive',
            _('Hide when nothing is playing'),
            _('Remove the indicator from the panel while no media player is running.')));
        page.add(placement);

        /* Listed in the order they appear on screen. */
        const buttons = new Adw.PreferencesGroup({
            title: _('Playback controls'),
            description: _('Which buttons appear in the panel.'),
        });
        buttons.add(this._switchRow(settings, 'show-shuffle',
            _('Shuffle'),
            _('Requires a player that supports shuffle.')));
        buttons.add(this._switchRow(settings, 'show-previous', _('Previous track')));
        buttons.add(this._switchRow(settings, 'show-seek-backward',
            _('Skip backward'),
            _('Requires a player that supports seeking.')));
        buttons.add(this._switchRow(settings, 'show-play-pause', _('Play and pause')));
        buttons.add(this._switchRow(settings, 'show-seek-forward',
            _('Skip forward'),
            _('Requires a player that supports seeking.')));
        buttons.add(this._switchRow(settings, 'show-next', _('Next track')));
        buttons.add(this._switchRow(settings, 'show-loop',
            _('Loop'),
            _('Cycles between off, the whole queue, and one track. Requires a player that supports looping.')));
        page.add(buttons);

        const text = new Adw.PreferencesGroup({
            title: _('Track information'),
            description: _('What the indicator shows about the current track.'),
        });
        text.add(this._switchRow(settings, 'show-player-icon', _('Player icon')));
        text.add(this._switchRow(settings, 'show-title', _('Track title')));
        text.add(this._switchRow(settings, 'show-artist', _('Artist')));
        text.add(this._spinRow(settings, 'panel-text-width',
            _('Text width'),
            _('Width reserved for the track text, in pixels. The indicator keeps this width whatever is playing.'),
            60, 600, 10));
        page.add(text);

        const scrolling = new Adw.PreferencesGroup({
            title: _('Scrolling text'),
            description: _('What happens when the track text is wider than the reserved width.'),
        });
        scrolling.add(this._switchRow(settings, 'scroll-text',
            _('Scroll the text'),
            _('Scrolls once for each new track. When off, text that does not fit is shortened with an ellipsis.')));
        scrolling.add(this._bindSensitive(settings, 'scroll-text',
            this._comboRow(settings, 'scroll-direction', _('Direction'),
                DIRECTIONS, directionLabels())));
        scrolling.add(this._bindSensitive(settings, 'scroll-text',
            this._spinRow(settings, 'scroll-speed',
                _('Speed'), _('Pixels per second.'), 10, 120, 5)));
        page.add(scrolling);

        return page;
    }

    _cardPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Card'),
            icon_name: 'audio-x-generic-symbolic',
        });

        const appearance = new Adw.PreferencesGroup({
            title: _('Appearance'),
            description: _('The card is shown when you click the panel indicator.'),
        });
        appearance.add(this._switchRow(settings, 'card-show-art',
            _('Album art'),
            _('Falls back to the player icon when the track has no artwork.')));
        appearance.add(this._bindSensitive(settings, 'card-show-art',
            this._comboRow(settings, 'card-art-size', _('Album art size'),
                ART_SIZES, artSizeLabels())));
        appearance.add(this._switchRow(settings, 'card-art-backdrop',
            _('Colors from album art'),
            _('Fill the card with a dark frosted-glass backdrop blurred from the album art, in both the light and the dark style. When off, or for tracks without artwork, the card keeps its plain background.')));
        appearance.add(this._spinRow(settings, 'card-width',
            _('Card width'), _('Measured in pixels.'), 400, 560, 10));
        page.add(appearance);

        const multiple = new Adw.PreferencesGroup({
            title: _('Multiple players'),
            description: _('What happens when more than one media player is running.'),
        });
        multiple.add(this._switchRow(settings, 'card-show-player-switcher',
            _('Player switcher'),
            _('A button beside the volume bar names the player on screen, and lists every running player, with what each is playing, for choosing which one the card and panel follow.')));
        multiple.add(this._switchRow(settings, 'pause-others-on-play',
            _('Play one player at a time'),
            _('When a player starts playing, pause whichever other player was playing. Players already running when the extension starts are left alone.')));
        page.add(multiple);

        const playback = new Adw.PreferencesGroup({
            title: _('Playback'),
            description: _('Optional controls the card offers alongside play, pause and track switching.'),
        });
        playback.add(this._switchRow(settings, 'card-show-seek-bar',
            _('Seek bar'),
            _('Requires a player that reports the track length.')));
        playback.add(this._switchRow(settings, 'card-show-seek-buttons',
            _('Skip buttons'),
            _('Requires a player that supports seeking.')));
        playback.add(this._spinRow(settings, 'seek-step-seconds',
            _('Skip amount'),
            _('How far the skip buttons jump, in seconds. Shared with the panel skip buttons.'),
            2, 20, 1));
        playback.add(this._switchRow(settings, 'card-show-shuffle',
            _('Shuffle button'),
            _('Shown at the left edge of the controls. Requires a player that supports shuffle.')));
        playback.add(this._switchRow(settings, 'card-show-loop',
            _('Loop button'),
            _('Shown at the right edge of the controls. Cycles between off, the whole queue, and one track.')));
        playback.add(this._switchRow(settings, 'card-show-volume',
            _('Volume bar'),
            _('Shown under the controls. Sets the volume of the player itself, not of the whole system. Requires a player that supports it; browsers do not.')));
        playback.add(this._switchRow(settings, 'card-show-output-switcher',
            _('Sound output button'),
            _('Shown at the bottom right of the card while more than one output is available, such as speakers and headphones. Switches the output of the whole system, as the sound menu does, so every app moves to it.')));
        page.add(playback);

        const lyrics = new Adw.PreferencesGroup({
            title: _('Lyrics'),
            description: _('A button beside the settings button shows the words of the current song. Timed lyrics follow along line by line, and clicking a line plays from there. Shown for music players only — not for browsers, nor for films in video players.'),
        });
        lyrics.add(this._switchRow(settings, 'card-show-lyrics-button',
            _('Lyrics button')));
        lyrics.add(this._bindSensitive(settings, 'card-show-lyrics-button',
            this._switchRow(settings, 'lyrics-online-lookup',
                _('Look up lyrics online'),
                _('When the player has none and there is no .lrc file beside the track, search LRCLIB (lrclib.net). The title, artist, album and length of the track are sent, and only while the lyrics are open.'))));
        lyrics.add(this._bindSensitive(settings, 'card-show-lyrics-button',
            this._spinRow(settings, 'lyrics-height',
                _('Lyrics height'),
                _('Measured in pixels. Made shorter on screens too small for it, so the card always fits.'),
                160, 560, 20)));
        page.add(lyrics);

        return page;
    }

    _maintenancePage(settings, window) {
        const page = new Adw.PreferencesPage({
            title: _('Maintenance'),
            icon_name: 'applications-utilities-symbolic',
        });

        const cache = new Adw.PreferencesGroup({
            title: _('Album art cache'),
            description: _('Artwork downloaded from players that publish it over the web is stored on disk so it is not fetched again. Removing it is safe; anything still needed is downloaded once more.'),
        });

        const status = new Adw.ActionRow({title: _('Cached artwork')});
        cache.add(status);
        this._refreshCacheStatus(status);

        const clear = new Adw.ButtonRow({title: _('Clear Cache…')});
        clear.add_css_class('destructive-action');
        clear.connect('activated', () => this._onClearCache(window, status));
        cache.add(clear);
        page.add(cache);

        const reset = new Adw.PreferencesGroup({
            title: _('Reset'),
            description: _('Return every setting on the Panel and Card pages to the value it shipped with.'),
        });
        const resetRow = new Adw.ButtonRow({title: _('Reset All Settings…')});
        resetRow.add_css_class('destructive-action');
        resetRow.connect('activated', () => this._onReset(window, settings));
        reset.add(resetRow);
        page.add(reset);

        return page;
    }

    /* Resolves to whether the user confirmed. */
    _confirm(window, heading, body, confirmLabel) {
        return new Promise(resolve => {
            const dialog = new Adw.AlertDialog({heading, body});
            dialog.add_response('cancel', _('Cancel'));
            dialog.add_response('confirm', confirmLabel);
            dialog.set_response_appearance('confirm',
                Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.set_default_response('cancel');
            dialog.set_close_response('cancel');
            dialog.choose(window, null, (source, result) =>
                resolve(source.choose_finish(result) === 'confirm'));
        });
    }

    /* Calls onInfo per Gio.FileInfo, then onDone once. A missing directory
     * just means nothing has been cached yet. */
    _walkCache(attributes, onInfo, onDone) {
        artCacheDir().enumerate_children_async(
            attributes, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null,
            (dir, result) => {
                let enumerator;
                try {
                    enumerator = dir.enumerate_children_finish(result);
                } catch {
                    onDone();
                    return;
                }

                const readBatch = () => {
                    enumerator.next_files_async(
                        ENUMERATE_BATCH, GLib.PRIORITY_DEFAULT, null,
                        (source, batch) => {
                            let infos;
                            try {
                                infos = source.next_files_finish(batch);
                            } catch {
                                onDone();
                                return;
                            }
                            if (infos.length === 0) {
                                onDone();
                                return;
                            }
                            infos.forEach(onInfo);
                            readBatch();
                        });
                };
                readBatch();
            });
    }

    _refreshCacheStatus(row) {
        row.subtitle = _('Measuring…');

        let files = 0;
        let bytes = 0;
        this._walkCache(
            `${Gio.FILE_ATTRIBUTE_STANDARD_NAME},${Gio.FILE_ATTRIBUTE_STANDARD_SIZE}`,
            info => {
                files++;
                bytes += info.get_size();
            },
            () => {
                if (files === 0) {
                    row.subtitle = _('Nothing cached.');
                    return;
                }
                const counted = files === 1 ? _('1 file') : `${files} ${_('files')}`;
                row.subtitle = `${counted} · ${GLib.format_size(bytes)}`;
            });
    }

    async _onClearCache(window, status) {
        const ok = await this._confirm(window,
            _('Clear the album art cache?'),
            _('Every downloaded cover is deleted from disk. Artwork for the tracks you play next is downloaded again.'),
            _('Clear'));
        if (!ok)
            return;

        status.subtitle = _('Clearing…');

        const dir = artCacheDir();
        const names = [];
        this._walkCache(Gio.FILE_ATTRIBUTE_STANDARD_NAME,
            info => names.push(info.get_name()),
            () => {
                /* The extension may be writing here right now, so a file
                 * vanishing underneath is expected. */
                let outstanding = names.length;
                if (outstanding === 0) {
                    this._refreshCacheStatus(status);
                    return;
                }

                for (const name of names) {
                    dir.get_child(name).delete_async(
                        GLib.PRIORITY_DEFAULT, null, (file, result) => {
                            try {
                                file.delete_finish(result);
                            } catch {
                                /* Already gone. */
                            }
                            if (--outstanding === 0)
                                this._refreshCacheStatus(status);
                        });
                }
            });
    }

    async _onReset(window, settings) {
        const ok = await this._confirm(window,
            _('Reset all settings?'),
            _('Every option returns to its default. This cannot be undone.'),
            _('Reset'));
        if (!ok)
            return;

        /* Keys come from the schema so new ones are covered. The announced
         * release is bookkeeping; resetting it would repeat the what's-new
         * notification. */
        for (const key of settings.settings_schema.list_keys()) {
            if (key !== 'last-announced-version')
                settings.reset(key);
        }
    }
}
