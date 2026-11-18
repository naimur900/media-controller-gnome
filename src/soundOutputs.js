// SPDX-License-Identifier: GPL-2.0-or-later
/* soundOutputs.js: the system's sound outputs (speakers, headphones, HDMI,
 * Bluetooth) and which one is playing. Picking one makes it the default
 * output, the same switch as the shell's sound menu, so it moves every app
 * that follows the default rather than only the player on screen. */

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gvc from 'gi://Gvc';

/* Devices name color icons, which the card cannot tint; the names fall back
 * to the generic audio icon. */
function symbolicIcon(iconName) {
    const name = iconName?.replace(/-symbolic$/, '') || 'audio-speakers';
    return Gio.ThemedIcon.new_with_default_fallbacks(`${name}-symbolic`);
}

export const SoundOutputs = GObject.registerClass({
    Signals: {
        /* An output came or went, or another became the default. */
        'changed': {},
    },
}, class SoundOutputs extends GObject.Object {
    _init() {
        super._init();

        /* Keyed by the mixer's device id, in the order the mixer found them,
         * which does not change as the default does. */
        this._outputs = new Map();
        this._activeId = null;

        /* A connection of its own: the shell's mixer announced its devices
         * while the shell started, and there is no call to list them again. */
        this._control = new Gvc.MixerControl({name: 'Media Controls'});
        this._controlSignals = [
            this._control.connect('output-added', (_control, id) => this._add(id)),
            this._control.connect('output-removed', (_control, id) => this._remove(id)),
            this._control.connect('active-output-update',
                (_control, id) => this._setActive(id)),
        ];
        this._control.open();
    }

    /* [{id, name, origin, kind, gicon}]; origin is the name of the card or
     * device behind the output, and may be ''. kind is one of 'built-in',
     * 'display' (HDMI or DisplayPort on a built-in card), 'usb', 'bluetooth'
     * or 'other' (no card, as for a virtual output). */
    get outputs() {
        return [...this._outputs.values()];
    }

    get activeId() {
        return this._activeId;
    }

    /* The open mixer connection, shared with the panel's scroll volume, which
     * changes the streams of players that have no volume of their own. */
    get mixer() {
        return this._control;
    }

    /* The mixer can name the default before announcing it, so this may be
     * null for a moment. */
    get active() {
        return this._outputs.get(this._activeId) ?? null;
    }

    /* The mixer answers with 'active-output-update' once the sound server
     * has switched; switching to an output on another card profile changes
     * the profile too. */
    select(id) {
        const device = this._control.lookup_output_id(id);
        if (device)
            this._control.change_output(device);
    }

    _add(id) {
        const device = this._control.lookup_output_id(id);
        if (!device)
            return;

        this._outputs.set(id, {
            id,
            name: device.get_description() ?? '',
            origin: device.get_origin() ?? '',
            kind: this._kind(device),
            gicon: symbolicIcon(device.get_icon_name()),
        });
        this.emit('changed');
    }

    /* From the card's icon, which ends in its bus: audio-card-analog-pci,
     * audio-card-analog-usb, audio-headphones-bluetooth. A device's origin is
     * its card's name; the device's own card property is a bare pointer GJS
     * cannot read. */
    _kind(device) {
        const origin = device.get_origin();
        const card = this._control.get_cards().find(c => c.get_name() === origin);
        if (!card)
            return 'other';

        const cardIcon = card.get_icon_name() ?? '';
        if (cardIcon.endsWith('-bluetooth'))
            return 'bluetooth';
        if (cardIcon.endsWith('-usb'))
            return 'usb';
        return device.get_icon_name()?.startsWith('video-display') ? 'display' : 'built-in';
    }

    _remove(id) {
        if (this._outputs.delete(id))
            this.emit('changed');
    }

    _setActive(id) {
        if (id === this._activeId)
            return;
        this._activeId = id;
        this.emit('changed');
    }

    destroy() {
        for (const id of this._controlSignals)
            this._control.disconnect(id);
        this._controlSignals = [];
        this._control.close();
        this._control = null;
        this._outputs.clear();
    }
});
