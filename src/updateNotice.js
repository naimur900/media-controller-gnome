// SPDX-License-Identifier: GPL-2.0-or-later
/* updateNotice.js: a one-off "what's new" notification after an update.
 * `last-announced-version` keeps it from repeating, since every login and
 * unlock re-enables the extension. */

import GLib from 'gi://GLib';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

/* Bump together with releaseNotes() to announce a release; leave both alone
 * and the release stays quiet. */
const RELEASE = '3.6';

function releaseNotes() {
    return [
        _('The volume bar on the card now works for browsers like Chrome and Firefox too. It dims while the browser isn’t playing.'),
        _('The card stays easy to read with the Openbar extension’s light menus.'),
        _('The volume bar can be hidden under Card in the preferences.'),
    ].map(line => `• ${line}`).join('\n');
}

/* A banner raised while the shell is still starting up is easily missed. */
const DELAY_SECONDS = 5;

export class UpdateNotice {
    constructor(extension, settings) {
        this._extension = extension;
        this._settings = settings;
        this._source = null;
        this._timeoutId = 0;

        if (settings.get_string('last-announced-version') === RELEASE)
            return;

        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            DELAY_SECONDS, () => {
                this._timeoutId = 0;
                this._show();
                return GLib.SOURCE_REMOVE;
            });
    }

    _show() {
        this._settings.set_string('last-announced-version', RELEASE);

        this._source = new MessageTray.Source({
            title: this._extension.metadata.name,
            iconName: 'audio-x-generic-symbolic',
        });
        /* A source destroys itself once its last notification is dismissed. */
        this._source.connect('destroy', () => {
            this._source = null;
        });
        Main.messageTray.add(this._source);

        const notification = new MessageTray.Notification({
            source: this._source,
            title: _('What’s new in %s').format(RELEASE),
            body: releaseNotes(),
        });
        notification.connect('activated', () => this._extension.openPreferences());
        this._source.addNotification(notification);
    }

    destroy() {
        if (this._timeoutId)
            GLib.Source.remove(this._timeoutId);
        this._timeoutId = 0;

        this._source?.destroy();
        this._source = null;
    }
}
