// SPDX-License-Identifier: GPL-2.0-or-later
/* scrollingLabel.js: the panel's fixed-width track label. Text that does not
 * fit is ellipsized, or scrolled once per track, carousel style: drawn twice,
 * so the tail of one copy is still on screen as the head of the next comes in. */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {boxOrientation} from './compat.js';

/* Space between the two copies, so the wrap reads as a gap. */
const GAP = 32;

/* Time to read the start of the title before it moves off. */
const PAUSE_MS = 1200;

export const ScrollingLabel = GObject.registerClass(
class ScrollingLabel extends St.Widget {
    _init(styleClass) {
        super._init({
            /* FixedLayout gives each child its natural size, so the copies keep
             * their full text width however narrow the label is. */
            layout_manager: new Clutter.FixedLayout(),
            clip_to_allocation: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._text = '';
        this._width = 200;
        this._scrolling = false;
        this._speed = 30;
        this._rightToLeft = false;

        /* 0 when the text fits or scrolling is off. */
        this._distance = 0;
        this._settleId = 0;

        this._box = new St.BoxLayout({
            ...boxOrientation(Clutter.Orientation.HORIZONTAL),
            style: `spacing: ${GAP}px;`,
        });
        this._first = new St.Label({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
        this._second = new St.Label({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
        this._first.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._second.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._second.visible = false;
        this._box.add_child(this._first);
        this._box.add_child(this._second);
        this.add_child(this._box);

        /* Widths measured before the theme resolves the font are wrong, and the
         * font can change later. */
        this._styleId = this._first.connect('style-changed', () => this._update());
        /* style-changed alone would not restart scrolling once animations are
         * switched back on. */
        St.Settings.get().connectObject('notify::enable-animations',
            () => this._update(true), this);
        /* While unmapped (the panel hides under a fullscreen window), Clutter
         * skips transitions and runs onComplete at once: a pass started then
         * would be lost, and one under way would keep the frame clock ticking
         * with nothing drawn. So the pass waits, and starts over once the label
         * is back. The box is watched because it is what moves, and a parent
         * maps before its children. */
        this._mapId = this._box.connect('notify::mapped', () => {
            if (!this._second.visible)
                return;
            if (this._box.mapped)
                this._runPass();
            else
                this._stop();
        });

        this.connect('destroy', () => this._onDestroy());
    }

    setText(text) {
        if (text === this._text)
            return;
        this._text = text;
        this._update(true);
    }

    setWidth(width) {
        if (width === this._width)
            return;
        this._width = width;
        this._update(true);
    }

    /* speed is in pixels per second. */
    setScrolling(enabled, speed, rightToLeft) {
        if (enabled === this._scrolling && speed === this._speed &&
            rightToLeft === this._rightToLeft)
            return;
        this._scrolling = enabled;
        this._speed = speed;
        this._rightToLeft = rightToLeft;
        this._update(true);
    }

    _textWidth() {
        return this._first.clutter_text.get_preferred_width(-1)[1];
    }

    /* force restarts the pass even if the geometry is unchanged. */
    _update(force = false) {
        this._first.text = this._text;
        this.set_width(this._width);

        const fullWidth = this._textWidth();
        if (!this._scrolling || fullWidth <= this._width) {
            this._distance = 0;
            this._showStatic();
            return;
        }

        const distance = fullWidth + GAP;
        /* style-changed fires on every hover and menu open; do not replay the
         * scroll when nothing moved. */
        if (!force && this._distance === distance)
            return;

        this._stop();
        this._first.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._first.set_width(-1);
        this._second.text = this._text;
        this._second.visible = true;
        this._distance = distance;
        this._start();
    }

    /* One ellipsized copy. Pinning it to the label's width is what makes Pango
     * add the ellipsis; at its natural width the clip would just cut it off. */
    _showStatic() {
        this._stop();
        this._first.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._first.set_width(this._width);
        this._second.visible = false;
    }

    _start() {
        if (!St.Settings.get().enable_animations) {
            this._showStatic();
            return;
        }
        this._runPass();
    }

    /* The pass shifts the box by one copy plus the gap, which lands on the same
     * picture it started from, so settling into the static label is seamless
     * in either direction. */
    _runPass() {
        if (!this._box.mapped)
            return;

        const [from, to] = this._rightToLeft
            ? [0, -this._distance]
            : [-this._distance, 0];

        this._box.translation_x = from;
        this._box.ease({
            translation_x: to,
            duration: (this._distance / Math.max(1, this._speed)) * 1000,
            delay: PAUSE_MS,
            mode: Clutter.AnimationMode.LINEAR,
            onComplete: () => this._queueSettle(),
        });
    }

    /* Clutter removes the finished transition by property name *after*
     * onComplete returns, tearing down anything the callback set up, so
     * settling happens from an idle. */
    _queueSettle() {
        if (this._settleId)
            return;
        this._settleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._settleId = 0;
            this._showStatic();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stop() {
        if (this._settleId)
            GLib.Source.remove(this._settleId);
        this._settleId = 0;
        this._box.remove_all_transitions();
        this._box.translation_x = 0;
    }

    _onDestroy() {
        this._stop();
        if (this._styleId)
            this._first.disconnect(this._styleId);
        this._styleId = 0;
        if (this._mapId)
            this._box.disconnect(this._mapId);
        this._mapId = 0;
    }
});
