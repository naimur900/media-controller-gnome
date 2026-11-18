// SPDX-License-Identifier: GPL-2.0-or-later
/* shellMediaControls.js: hides the media player GNOME shows in the
 * notification list under the clock, which repeats the panel indicator and the
 * card. Only the shell's own instances are changed, never its classes, and
 * setHidden(false) puts back exactly what the shell had.
 *
 * GNOME 48 rebuilt the notification list, so there are two ways of doing it:
 * - 48 and later: a MessageView adds one message per player from its
 *   MprisSource. Its handlers are disconnected and the messages removed
 *   through its own _removePlayer(), which keeps the count it places
 *   notifications after; its own _setupMpris() restores both.
 * - 47: a MediaSection whose visibility comes from _shouldShow(). An instance
 *   override keeps it hidden through every resync; the list already treats a
 *   hidden section as empty, so "No Notifications" still shows. */

export class ShellMediaControls {
    /* messageList: the date menu's CalendarMessageList, or null when the
     * session has none, in which case nothing is done. */
    constructor(messageList) {
        this._messageList = messageList;
        this._hidden = false;
    }

    setHidden(hidden) {
        if (hidden === this._hidden)
            return;
        this._hidden = hidden;

        const view = this._messageList?._messageView;
        if (view?._mediaSource && view._playerToMessage)
            this._setViewHidden(view, hidden);
        else if (this._messageList?._mediaSection)
            this._setSectionHidden(this._messageList._mediaSection, hidden);
    }

    _setViewHidden(view, hidden) {
        if (!hidden) {
            view._setupMpris();
            return;
        }

        view._mediaSource.disconnectObject(view);
        for (const player of [...view._playerToMessage.keys()])
            view._removePlayer(player);
    }

    _setSectionHidden(section, hidden) {
        if (hidden)
            section._shouldShow = () => false;
        else
            delete section._shouldShow;
        section._sync();
    }

    destroy() {
        this.setHidden(false);
        this._messageList = null;
    }
}
