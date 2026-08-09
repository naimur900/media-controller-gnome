// SPDX-License-Identifier: GPL-2.0-or-later
/* mpris.js
 *
 * Talks to any application implementing the MPRIS2 spec on the session bus.
 * Exposes a single `MprisManager` that tracks every running player and picks
 * one "active" player for the UI to render.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {resolvePlayerIcon} from './playerIcons.js';

const GENERIC_ICON = 'audio-x-generic-symbolic';

const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';

/* playerctld mirrors whichever player is active, which would show up as a
 * duplicate of a player we already track. */
const IGNORED_BUS_NAMES = ['org.mpris.MediaPlayer2.playerctld'];

const DBusIface = `
<node>
  <interface name="org.freedesktop.DBus">
    <method name="ListNames">
      <arg type="as" direction="out" name="names"/>
    </method>
    <signal name="NameOwnerChanged">
      <arg type="s" name="name"/>
      <arg type="s" name="oldOwner"/>
      <arg type="s" name="newOwner"/>
    </signal>
  </interface>
</node>`;

const MprisIface = `
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <method name="Quit"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
    <property name="CanRaise" type="b" access="read"/>
  </interface>
</node>`;

const PlayerIface = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="PlayPause"/>
    <method name="Play"/>
    <method name="Pause"/>
    <method name="Stop"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Seek">
      <arg type="x" direction="in" name="offset"/>
    </method>
    <method name="SetPosition">
      <arg type="o" direction="in" name="trackId"/>
      <arg type="x" direction="in" name="position"/>
    </method>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="LoopStatus" type="s" access="readwrite"/>
    <property name="Shuffle" type="b" access="readwrite"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Position" type="x" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <signal name="Seeked">
      <arg type="x" name="position"/>
    </signal>
  </interface>
</node>`;

/** Unwrap a GLib.Variant coming out of an a{sv} without assuming its type. */
function unwrap(variant) {
    if (!variant)
        return null;
    try {
        return variant.deep_unpack();
    } catch {
        return null;
    }
}

/** MPRIS metadata is famously inconsistent; coerce whatever we get to a string. */
function asString(value) {
    if (value === null || value === undefined)
        return '';
    if (Array.isArray(value))
        return value.filter(v => typeof v === 'string' && v).join(', ');
    if (typeof value === 'string')
        return value;
    return String(value);
}

function asNumber(value) {
    if (typeof value === 'bigint')
        return Number(value);
    if (typeof value === 'number')
        return value;
    return 0;
}

/* Every D-Bus call here can lose a race with the player leaving the bus, and
 * they all fail the same way. Funnelling the warnings through one place keeps
 * the reporting consistent and the logging sparse, as the review guidelines
 * ask. `context` names what failed; the trailing message comes from the error. */
function logError(context, error) {
    console.warn(`media-controls: ${context}: ${error.message}`);
}

export const MprisPlayer = GObject.registerClass({
    Signals: {
        'changed': {},
        'seeked': {param_types: [GObject.TYPE_INT64]},
    },
}, class MprisPlayer extends GObject.Object {
    _init(busName) {
        super._init();

        this.busName = busName;
        this._cancellable = new Gio.Cancellable();
        this._iconCacheKey = null;
        this._iconCache = null;
        this._genericIcon = null;
        this._metadata = null;

        this._playerProxy = null;
        this._appProxy = null;
        this._propsChangedId = 0;
        this._seekedId = 0;

        /* The wrapper classes are built here rather than at module scope:
         * modules stay loaded across disable/enable, so nothing GObject-related
         * may be created at import time. */
        const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(PlayerIface);
        const MprisProxy = Gio.DBusProxy.makeProxyWrapper(MprisIface);

        new PlayerProxy(Gio.DBus.session, busName, MPRIS_PATH, (proxy, error) => {
            if (error) {
                /* CANCELLED means destroy() ran while the init was in flight. */
                if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    logError(`player proxy for ${busName}`, error);
                return;
            }
            this._playerProxy = proxy;
            this._propsChangedId = proxy.connect('g-properties-changed', () => {
                this._metadata = null;
                this.emit('changed');
            });
            this._seekedId = proxy.connectSignal('Seeked',
                (_p, _sender, [position]) => this.emit('seeked', asNumber(position)));
            this.emit('changed');
        }, this._cancellable, Gio.DBusProxyFlags.NONE);

        new MprisProxy(Gio.DBus.session, busName, MPRIS_PATH, (proxy, error) => {
            if (error) {
                /* Cancelled on destroy — and the app interface is optional in
                 * practice anyway; not fatal. */
                return;
            }
            this._appProxy = proxy;
            this.emit('changed');
        }, this._cancellable, Gio.DBusProxyFlags.NONE);
    }

    get ready() {
        return this._playerProxy !== null;
    }

    /**
     * Reading `proxy.Metadata` deep-unpacks the whole a{sv} every time, and a
     * single UI sync asks for half a dozen of its keys. Unpack it once per
     * PropertiesChanged instead; the handler above drops the cache.
     */
    _metadataDict() {
        if (this._metadata)
            return this._metadata;
        /* Nothing to cache until the proxy lands; it emits 'changed' when it does. */
        if (!this._playerProxy)
            return {};
        this._metadata = this._playerProxy.Metadata ?? {};
        return this._metadata;
    }

    _meta(key) {
        return unwrap(this._metadataDict()[key]);
    }

    get title() {
        return asString(this._meta('xesam:title'));
    }

    get artist() {
        return asString(this._meta('xesam:artist'));
    }

    get album() {
        return asString(this._meta('xesam:album'));
    }

    get artUrl() {
        return asString(this._meta('mpris:artUrl'));
    }

    get trackId() {
        return asString(this._meta('mpris:trackid'));
    }

    /** Track length in microseconds, or 0 when the player does not report it. */
    get length() {
        return asNumber(this._meta('mpris:length'));
    }

    get status() {
        return this._playerProxy?.PlaybackStatus ?? 'Stopped';
    }

    get isPlaying() {
        return this.status === 'Playing';
    }

    /* Some players omit the Can* properties entirely. Assume the capability is
     * present in that case so we do not grey out buttons that actually work. */
    get canPlay() {
        return this._playerProxy?.CanPlay ?? true;
    }

    get canPause() {
        return this._playerProxy?.CanPause ?? true;
    }

    get canGoNext() {
        return this._playerProxy?.CanGoNext ?? true;
    }

    get canGoPrevious() {
        return this._playerProxy?.CanGoPrevious ?? true;
    }

    get canSeek() {
        return this._playerProxy?.CanSeek ?? false;
    }

    /* LoopStatus and Shuffle are optional in MPRIS. Here `null` means the
     * player does not implement the property at all, which the UI turns into
     * "no button" — unlike the Can* fallbacks above, absence is a capability
     * signal, not a value to guess. */
    get loopStatus() {
        const status = this._playerProxy?.LoopStatus;
        return typeof status === 'string' ? status : null;
    }

    get canLoop() {
        return this.loopStatus !== null;
    }

    get shuffle() {
        const shuffle = this._playerProxy?.Shuffle;
        return typeof shuffle === 'boolean' ? shuffle : null;
    }

    get canShuffle() {
        return this.shuffle !== null;
    }

    get canRaise() {
        return this._appProxy?.CanRaise ?? false;
    }

    get identity() {
        return this._appProxy?.Identity ?? this.busName.replace(MPRIS_PREFIX, '');
    }

    get desktopEntry() {
        return this._appProxy?.DesktopEntry ?? '';
    }

    /**
     * Resolution walks the desktop file index and the icon theme, and this is
     * read on every UI sync, so the result is cached against the properties it
     * was derived from. Both arrive asynchronously with the app proxy, so the
     * key — not a "resolved once" flag — is what lets a better icon land later.
     */
    _resolveIcon() {
        const key = JSON.stringify([this.desktopEntry, this.identity]);
        if (this._iconCacheKey !== key) {
            this._iconCacheKey = key;
            this._iconCache = resolvePlayerIcon({
                busName: this.busName,
                desktopEntry: this.desktopEntry,
                identity: this.identity,
            });
        }
        return this._iconCache;
    }

    /** True when we found the player's real icon rather than a generic one. */
    get hasAppIcon() {
        return this._resolveIcon() !== null;
    }

    /** Best-effort app icon for this player; never null. */
    get appIcon() {
        this._genericIcon ??= Gio.ThemedIcon.new(GENERIC_ICON);
        return this._resolveIcon() ?? this._genericIcon;
    }

    /* Any of these can race with the player disappearing from the bus, so every
     * call swallows its own error rather than taking down the shell. */
    _call(method) {
        if (!this._playerProxy)
            return;
        try {
            this._playerProxy[`${method}Remote`](() => {});
        } catch (e) {
            logError(`${method} failed`, e);
        }
    }

    playPause() {
        this._call('PlayPause');
    }

    /**
     * Pause outright rather than toggling. PlayPause would restart a player
     * that has already stopped by the time the call lands, which is exactly
     * the wrong outcome when the point is to get out of another player's way.
     */
    pause() {
        if (!this.canPause)
            return;
        this._call('Pause');
    }

    next() {
        this._call('Next');
    }

    previous() {
        this._call('Previous');
    }

    /* Property assignment on a GJS proxy updates the cached value at once and
     * issues the D-Bus Properties.Set call asynchronously, so a sync() right
     * after the click already paints the new state; players that reject the
     * write correct it with their next PropertiesChanged. */
    setLoopStatus(status) {
        if (!this._playerProxy || !this.canLoop)
            return;
        try {
            this._playerProxy.LoopStatus = status;
        } catch (e) {
            logError('set LoopStatus failed', e);
        }
    }

    setShuffle(shuffle) {
        if (!this._playerProxy || !this.canShuffle)
            return;
        try {
            this._playerProxy.Shuffle = shuffle;
        } catch (e) {
            logError('set Shuffle failed', e);
        }
    }

    raise() {
        if (!this._appProxy || !this.canRaise)
            return;
        try {
            this._appProxy.RaiseRemote(() => {});
        } catch (e) {
            logError('Raise failed', e);
        }
    }

    /**
     * The Position property is intentionally excluded from PropertiesChanged by
     * the MPRIS spec, so a cached read would be stale. Always ask the bus.
     *
     * @returns {Promise<number>} position in microseconds
     */
    getPosition() {
        return new Promise(resolve => {
            if (!this._playerProxy) {
                resolve(0);
                return;
            }
            Gio.DBus.session.call(
                this.busName, MPRIS_PATH, PROPS_IFACE, 'Get',
                new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']),
                new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, -1,
                this._cancellable,
                (connection, result) => {
                    try {
                        const [value] = connection.call_finish(result).deep_unpack();
                        resolve(asNumber(value.deep_unpack()));
                    } catch {
                        resolve(0);
                    }
                });
        });
    }

    /**
     * Seek relative to the current position. Negative offsets rewind; the spec
     * says players clamp to the start of the track themselves.
     *
     * @param {number} offset in microseconds
     */
    seek(offset) {
        if (!this._playerProxy || !this.canSeek)
            return;
        try {
            this._playerProxy.SeekRemote(offset, () => {});
        } catch (e) {
            logError('relative seek failed', e);
        }
    }

    /**
     * @param {number} position absolute position in microseconds
     */
    setPosition(position) {
        if (!this._playerProxy || !this.canSeek)
            return;

        const warn = e => logError('seek failed', e);

        /* SetPosition needs a valid object path. Players that report a bogus
         * trackid (or none) get a relative Seek instead. */
        const trackId = this.trackId;
        if (trackId && trackId.startsWith('/')) {
            try {
                this._playerProxy.SetPositionRemote(trackId, position, () => {});
            } catch (e) {
                warn(e);
            }
            return;
        }

        /* The Seek runs after a round trip, so a synchronous `try` around this
         * call would already have returned by the time it could throw. */
        this.getPosition()
            .then(current => this._playerProxy?.SeekRemote(position - current, () => {}))
            .catch(warn);
    }

    destroy() {
        this._cancellable.cancel();

        if (this._playerProxy) {
            if (this._propsChangedId)
                this._playerProxy.disconnect(this._propsChangedId);
            if (this._seekedId)
                this._playerProxy.disconnectSignal(this._seekedId);
        }
        this._propsChangedId = 0;
        this._seekedId = 0;
        this._playerProxy = null;
        this._appProxy = null;
        this._metadata = null;
    }
});

export const MprisManager = GObject.registerClass({
    Signals: {
        /* Emitted when the active player, or anything about it, changes. */
        'changed': {},
        /* Emitted when the set of running players changes, or when one of them
         * gains the identity or icon the switcher renders it with. */
        'players-changed': {},
    },
}, class MprisManager extends GObject.Object {
    _init() {
        super._init();

        this._players = new Map();
        this._playerSignals = new Map();
        this._active = null;
        this._pinned = null;
        this._roster = '';
        this._statuses = new Map();
        this._loaded = false;
        this._cancellable = new Gio.Cancellable();

        /* Set by the extension from the `pause-others-on-play` setting: when a
         * player starts, whichever other player was playing is paused. Off
         * until the extension says otherwise, so nothing touches the user's
         * playback before the setting has been read. */
        this.exclusivePlayback = false;

        const DBusProxy = Gio.DBusProxy.makeProxyWrapper(DBusIface);
        this._dbusProxy = new DBusProxy(Gio.DBus.session,
            'org.freedesktop.DBus', '/org/freedesktop/DBus',
            (proxy, error) => {
                /* Cancelled when destroy() beats the init to it. */
                if (error)
                    return;
                this._nameOwnerId = proxy.connectSignal('NameOwnerChanged',
                    (_p, _sender, [name, oldOwner, newOwner]) =>
                        this._onNameOwnerChanged(name, oldOwner, newOwner));
                this._loadExistingPlayers();
            }, this._cancellable, Gio.DBusProxyFlags.NONE);
    }

    get activePlayer() {
        return this._active;
    }

    get players() {
        return [...this._players.values()];
    }

    /**
     * The players the UI can actually control and switch between, oldest first:
     * the map is keyed by arrival, so this is the order they were opened in,
     * and a switcher with room for only a few of them can drop the ones that
     * have been sitting around longest. Players already running at startup are
     * ordered by what the bus reports, which is the closest thing to an opening
     * order available after the fact.
     */
    get readyPlayers() {
        return this.players.filter(player => player.ready);
    }

    /**
     * Show this player, whatever else is playing.
     *
     * The choice sticks against the noise — a player's metadata updates several
     * times a second and none of that should move the card off what the user
     * asked for — but not against intent: the moment any other player starts
     * playing, _noteStatus() drops the pin and that player takes over. It is
     * also dropped when the pinned player leaves the bus.
     *
     * @param {string} busName the player's MPRIS bus name
     */
    selectPlayer(busName) {
        const player = this._players.get(busName);
        if (!player)
            return;

        this._pinned = busName;
        if (this._active === player)
            return;

        this._active = player;
        this.emit('changed');
    }

    _loadExistingPlayers() {
        /* The result must not be destructured in the parameter list: it is null
         * on error (including cancellation on destroy). */
        this._dbusProxy.ListNamesRemote((result, error) => {
            if (error)
                return;
            const [names] = result;
            for (const name of names) {
                if (this._isPlayerName(name))
                    this._addPlayer(name);
            }
            /* Everything from here on is a player that arrived while we were
             * watching — the distinction _noteStatus() draws before pausing
             * anything. */
            this._loaded = true;
            this._selectActive();
        }, this._cancellable);
    }

    _isPlayerName(name) {
        return name.startsWith(MPRIS_PREFIX) && !IGNORED_BUS_NAMES.includes(name);
    }

    _onNameOwnerChanged(name, oldOwner, newOwner) {
        if (!this._isPlayerName(name))
            return;

        if (newOwner && !oldOwner)
            this._addPlayer(name);
        else if (oldOwner && !newOwner)
            this._removePlayer(name);
        else
            return;

        this._selectActive();
    }

    _addPlayer(busName) {
        if (this._players.has(busName))
            return;

        const player = new MprisPlayer(busName);
        this._players.set(busName, player);

        /* A player that was already on the bus when the extension started has
         * no entry: _noteStatus() adopts whatever it is doing without treating
         * it as having just started, so enabling the extension never pauses
         * music that was already running. One that joins later starts from
         * "not playing", so its first Playing counts as a start. */
        if (this._loaded)
            this._statuses.set(busName, 'Stopped');

        this._playerSignals.set(busName, player.connect('changed', () => {
            this._noteStatus(player);

            const wasActive = this._active === player;
            /* Emits 'changed' itself when the active player flips. */
            this._selectActive();

            /* A background player updating its metadata is not news: only the
             * player on screen forces a re-render, and only when _selectActive()
             * has not already announced it. */
            if (wasActive && this._active === player)
                this.emit('changed');

            /* Both proxies land after the player is added, so this is where a
             * new player picks up its identity and icon. */
            this._notifyRoster();
        }));
        this._notifyRoster();
    }

    /**
     * Watch one player's PlaybackStatus for the moment it starts, which is the
     * only thing exclusive playback acts on. Every other property change moves
     * through here too, so it compares against the last status rather than
     * asking "is it playing" — otherwise a track's position updates would keep
     * re-pausing everything else.
     *
     * @param {object} player the MprisPlayer that just emitted 'changed'
     */
    _noteStatus(player) {
        const previous = this._statuses.get(player.busName);
        const status = player.status;
        if (status === previous)
            return;

        this._statuses.set(player.busName, status);

        if (status !== 'Playing')
            return;

        /* Pressing play somewhere is the clearest statement there is about
         * which player matters now, so it releases an earlier pick — otherwise
         * the card would sit on a player the user chose minutes ago while the
         * one they just started plays unseen, with no way back if the switcher
         * has no room to show it. */
        if (this._pinned && this._pinned !== player.busName)
            this._pinned = null;

        /* `undefined` is a player we are seeing for the first time and were not
         * around to watch start; leave it, and everyone else, alone. */
        if (previous !== undefined)
            this._pauseOthers(player);
    }

    /**
     * @param {object} player the player that just started, and is spared
     */
    _pauseOthers(player) {
        if (!this.exclusivePlayback)
            return;

        for (const other of this._players.values()) {
            if (other === player || !other.isPlaying)
                continue;

            other.pause();
            /* Record it now: the player's own PropertiesChanged will confirm
             * this in a moment, and until then a second start elsewhere should
             * not see it as still playing and pause it twice. */
            this._statuses.set(other.busName, 'Paused');
        }
    }

    /**
     * The switcher renders one button per player out of exactly these
     * properties, so this is what "the roster changed" means. Players emit
     * 'changed' several times a second while playing; comparing the signature
     * keeps that from rebuilding a row of buttons that has not moved.
     */
    _rosterSignature() {
        /* JSON rather than a joined string: an identity is arbitrary text from
         * the player, and could otherwise forge a field boundary. */
        return JSON.stringify(this.players.map(player =>
            [player.busName, player.ready, player.identity, player.desktopEntry]));
    }

    _notifyRoster() {
        const signature = this._rosterSignature();
        if (signature === this._roster)
            return;

        this._roster = signature;
        this.emit('players-changed');
    }

    _removePlayer(busName) {
        const player = this._players.get(busName);
        if (!player)
            return;

        const signalId = this._playerSignals.get(busName);
        if (signalId)
            player.disconnect(signalId);
        this._playerSignals.delete(busName);
        this._players.delete(busName);
        this._statuses.delete(busName);

        /* `_active` is left pointing at the removed player on purpose:
         * _selectActive() compares against it to decide whether to emit
         * 'changed'. Clearing it here would swallow that signal, leaving the
         * panel showing a player that has quit. */
        player.destroy();
        this._notifyRoster();
    }

    /* Scans the map in place; `players` would allocate a fresh array per call,
     * and this runs on every property change of every player. */
    _find(predicate) {
        for (const player of this._players.values()) {
            if (predicate(player))
                return player;
        }
        return null;
    }

    /**
     * A player the user picked wins outright. Failing that, prefer whatever is
     * actually playing, and otherwise keep the current player so the panel does
     * not jump around when a background player updates metadata.
     */
    _selectActive() {
        const previous = this._active;
        const pinned = this._pinned ? this._players.get(this._pinned) : null;

        /* The pinned player quit; fall back to choosing one automatically. */
        if (!pinned)
            this._pinned = null;

        if (pinned) {
            this._active = pinned;
        } else {
            if (!this._active || !this._players.has(this._active.busName))
                this._active = null;

            if (!this._active?.isPlaying)
                this._active = this._find(p => p.isPlaying) ?? this._active;

            if (!this._active || !this._players.has(this._active.busName))
                this._active = this._find(p => p.ready);
        }

        if (previous !== this._active)
            this.emit('changed');
    }

    destroy() {
        this._cancellable.cancel();

        if (this._dbusProxy && this._nameOwnerId)
            this._dbusProxy.disconnectSignal(this._nameOwnerId);
        this._nameOwnerId = 0;
        this._dbusProxy = null;

        for (const busName of [...this._players.keys()])
            this._removePlayer(busName);

        this._active = null;
        this._pinned = null;
        this._statuses.clear();
    }
});
