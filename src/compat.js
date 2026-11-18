// SPDX-License-Identifier: GPL-2.0-or-later
/* compat.js: differences between the GNOME Shell releases in metadata.json. */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

/* GNOME 48 added St.BoxLayout's `orientation` and deprecated `vertical`, the
 * only one GNOME 47 has; GJS throws on an unknown construct property. Spread
 * the result into the construct properties. */
export function boxOrientation(orientation) {
    if (GObject.Object.find_property.call(St.BoxLayout, 'orientation'))
        return {orientation};
    return {vertical: orientation === Clutter.Orientation.VERTICAL};
}

/* GNOME 49 replaced the OSD manager's show(monitorIndex, ...), where -1 meant
 * every monitor, with showAll() and showOne(). The manager is passed in so this
 * module keeps to gi:// imports. */
export function showOsd(osdWindowManager, icon, label, level, maxLevel) {
    if (osdWindowManager.showAll)
        osdWindowManager.showAll(icon, label, level, maxLevel);
    else
        osdWindowManager.show(-1, icon, label, level, maxLevel);
}
