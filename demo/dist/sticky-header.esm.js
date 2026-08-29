var MAX_OVERSHOOT = .2;
/**
* Damping ratio that produces a given peak overshoot in a step response.
* Inverse of Mp = e^(−πζ / √(1−ζ²)).
* @param {number} overshoot - Peak overshoot as a fraction (0.05 = 5%)
* @returns {number} Damping ratio ζ in (0, 1)
*/
function dampingRatioForOvershoot(overshoot) {
	const logOvershoot = Math.log(overshoot);
	return -logOvershoot / Math.sqrt(Math.PI * Math.PI + logOvershoot * logOvershoot);
}
/**
* Raw (un-normalized) underdamped step response.
* @param {number} t - Time in seconds
* @param {number} zeta - Damping ratio
* @returns {number} Response value
*/
function underdamped(t, zeta) {
	const dampedFrequency = 12 * Math.sqrt(1 - zeta * zeta);
	const decay = Math.exp(-zeta * 12 * t);
	const ratio = zeta / Math.sqrt(1 - zeta * zeta);
	return 1 - decay * (Math.cos(dampedFrequency * t) + ratio * Math.sin(dampedFrequency * t));
}
/**
* Raw (un-normalized) critically damped step response — no overshoot.
* @param {number} t - Time in seconds
* @returns {number} Response value
*/
function criticallyDamped(t) {
	return 1 - Math.exp(-12 * t) * (1 + 12 * t);
}
var easeCache = /* @__PURE__ */ new Map();
/**
* Builds a settle easing function for a given peak overshoot.
* The returned function maps normalized progress 0 → 1 onto the oscillator's
* step response, and is exact at both ends (0 → 0, 1 → 1).
* @param {number} overshoot - Peak overshoot as a fraction; 0 = critically damped
* @returns {(t: number) => number} Easing function
*/
function makeSettleEase(overshoot) {
	const amount = Number.isFinite(overshoot) ? Math.min(Math.max(overshoot, 0), MAX_OVERSHOOT) : 0;
	const cached = easeCache.get(amount);
	if (cached) return cached;
	let ease;
	if (amount <= 0) {
		const scale = 1 / criticallyDamped(1);
		ease = (t) => {
			if (t <= 0) return 0;
			if (t >= 1) return 1;
			return criticallyDamped(t) * scale;
		};
	} else {
		const zeta = dampingRatioForOvershoot(amount);
		const scale = 1 / underdamped(1, zeta);
		ease = (t) => {
			if (t <= 0) return 0;
			if (t >= 1) return 1;
			return underdamped(t, zeta) * scale;
		};
	}
	easeCache.set(amount, ease);
	return ease;
}
/**
* The DEFAULT curve (5% overshoot) as a CSS `linear()` timing function, for
* authors who want their own transitions to match the settle. 24 samples is
* enough for the bounce to read correctly at any duration the component uses.
*/
var SETTLE_LINEAR_CURVE = "linear(0, 0.1062, 0.3275, 0.5628, 0.7602, 0.9018, 0.9893, 1.0339, 1.0492, 1.0473, 1.0374, 1.0255, 1.0148, 1.0068, 1.0016, 0.9988, 0.9976, 0.9975, 0.9979, 0.9985, 0.9991, 0.9995, 0.9998, 1)";
//#endregion
//#region src/lib/viewport-metrics.js
/** Parks the probe outside layout, painting, hit-testing and a11y. */
var CONTAINER_STYLE = "position: fixed; top: 0; left: 0; width: 0; height: 0; overflow: hidden; visibility: hidden; pointer-events: none; z-index: -1;";
/**
* The live viewport height, used until (or unless) a probe exists.
* @returns {number} Height in px, 0 with no host environment
*/
function liveHeight() {
	return globalThis.visualViewport?.height || globalThis.innerHeight || 0;
}
var ViewportMetrics = {
	/** @type {number} Live visual viewport height — moves with mobile chrome. */
	currentHeight: 0,
	/** @type {number} `100svh` height — the one mobile chrome cannot move. */
	stableHeight: 0,
	/** @type {object | null} The `100svh` element that gets measured. */
	probe: null,
	/** @type {object | null} Its hidden wrapper, kept for `_reset()`. */
	container: null,
	/**
	* Creates the probe if it can be created. Safe to call repeatedly.
	* @returns {object} This singleton
	*/
	init() {
		if (this.probe) return this;
		if (typeof document === "undefined" || !document.documentElement) return this;
		const css = globalThis.CSS;
		if (typeof css?.supports !== "function" || !css.supports("height: 100svh")) return this;
		const container = document.createElement("div");
		const probe = document.createElement("div");
		container.setAttribute("aria-hidden", "true");
		container.style.cssText = CONTAINER_STYLE;
		probe.style.height = "100svh";
		container.appendChild(probe);
		document.documentElement.appendChild(container);
		this.container = container;
		this.probe = probe;
		return this;
	},
	/**
	* Re-reads both heights.
	* @returns {object} This singleton, so callers can read straight off it
	*/
	refresh() {
		this.init();
		const currentHeight = liveHeight();
		const measured = this.probe ? this.probe.getBoundingClientRect().height : 0;
		this.currentHeight = currentHeight;
		this.stableHeight = measured || currentHeight;
		return this;
	},
	/** Test hook: detach the probe so the next `refresh()` starts clean. */
	_reset() {
		if (typeof this.container?.remove === "function") this.container.remove();
		this.container = null;
		this.probe = null;
		this.currentHeight = 0;
		this.stableHeight = 0;
	}
};
var REFERENCE_FRAME_MS = 1e3 / 60;
var VELOCITY_DECAY_TAU = -16.666666666666668 / Math.log(.76);
var EMA_TAU = -16.666666666666668 / Math.log(.85);
/**
* Keeps a number within a range.
* @param {number} value
* @param {number} min
* @param {number} max
* @returns {number}
*/
function clamp(value, min, max) {
	return Math.max(min, Math.min(max, value));
}
/**
* Frame-rate-independent exponential approach.
*
* Moves `current` toward `target` by the fraction of the remaining gap that
* `dt` milliseconds is worth at time constant `tau` — about 63% of the gap per
* `tau` ms, regardless of how that time was carved into frames. Two runs over
* the same wall-clock span land on the same value whether they were ticked at
* 60Hz, 120Hz, or through dropped frames.
*
* Deliberately has no snap threshold: whether a remaining gap is small enough
* to close outright is the caller's judgement, and different consumers use
* different epsilons (px, progress, opacity).
* @param {number} current - Where the value is now
* @param {number} target - Where it is heading
* @param {number} dt - Elapsed milliseconds
* @param {number} tau - Time constant in ms; 0 or less snaps to target
* @returns {number} The advanced value
*/
function expApproach(current, target, dt, tau) {
	if (!(tau > 0)) return target;
	return current + (target - current) * (1 - Math.exp(-dt / tau));
}
/**
* Runs a subscriber callback without letting it escape the loop.
*
* Every callback here fires from inside a rAF callback. A throw there stops
* the loop re-arming while `_rafId` stays null and `_listening` stays true —
* every consumer on the page dies permanently, from one bad callback. Report
* and carry on instead.
* @param {*} fn - Callback candidate; ignored unless it is a function
* @param {*} [arg] - Single argument to pass
* @returns {*} The callback's return value, or undefined
*/
function safeCall(fn, arg) {
	if (typeof fn !== "function") return void 0;
	try {
		return fn(arg);
	} catch (error) {
		console.error(error);
		return;
	}
}
var ScrollHandler = {
	quietOnHeightResize: false,
	/** @type {Array<object>} Subscriptions, in subscription order. */
	_subs: [],
	_listening: false,
	_rafId: null,
	_idleTimer: null,
	/** rAF timestamp of the previous frame; 0 while the loop is asleep. */
	_lastFrameTime: 0,
	/** Clamped y the FRAME delta is measured from. */
	_lastScrollY: 0,
	/** Clamped y the per-EVENT velocity delta is measured from. */
	_lastEventY: 0,
	/** Clock time of the previous scroll event, for the EMA's own dt. */
	_lastEventTime: 0,
	_maxScrollY: 0,
	_velocity: 0,
	_quietUntil: 0,
	_lastWidth: 0,
	/** A rest is owed to subscribers — movement has happened since the last one. */
	_restPending: false,
	/** The next scroll is a restored position, not a gesture. */
	_rebaseOnNextScroll: false,
	/** @type {object | null | undefined} undefined = not resolved yet. */
	_rmq: void 0,
	handlers: {},
	/** @returns {number} Current scroll position, clamped to [0, maxScrollY]. */
	get y() {
		return this._lastScrollY;
	},
	/** @returns {number} Smoothed scroll velocity in px, clamped to ±100. */
	get velocity() {
		return this._velocity;
	},
	/** @returns {boolean} Whether the user asked for reduced motion. */
	get reducedMotion() {
		const query = this._motionQuery();
		return query ? !!query.matches : false;
	},
	/** @returns {number} The largest legal scroll position, from the cache. */
	get maxScrollY() {
		return this._maxScrollY;
	},
	/**
	* Subscribes to the scroll signal. Every callback is optional.
	*
	* The first subscription attaches the window listeners; the last
	* unsubscription detaches all of them, so an idle page holds nothing.
	* @param {object} [callbacks]
	* @param {(packet: object) => (boolean | void)} [callbacks.frame] - Per
	*   frame while the loop is awake. Return true to request another frame.
	* @param {() => void} [callbacks.rest] - True scroll rest.
	* @param {(reason: string) => void} [callbacks.rebase] - The position was
	*   adopted with no gesture: 'restore' | 'resize' | 'manual'.
	* @param {(metrics: object) => void} [callbacks.resize] - After a viewport
	*   change, with `{ currentHeight, stableHeight }`.
	* @returns {{ tick: () => void, unsubscribe: () => void }}
	*/
	subscribe(callbacks = {}) {
		const _ = this;
		const sub = {
			frame: callbacks.frame,
			rest: callbacks.rest,
			rebase: callbacks.rebase,
			resize: callbacks.resize,
			active: true,
			/** Wakes the loop without a scroll — observers, attribute changes. */
			tick: () => _.tick(),
			unsubscribe: () => _._unsubscribe(sub)
		};
		_._subs.push(sub);
		if (_._subs.length === 1) _._start();
		_.tick();
		return sub;
	},
	/**
	* Re-anchors scroll tracking to the current position, producing no delta on
	* the next frame. Consumers call this from their own `refresh()` paths.
	* @param {string} [reason='manual'] - 'restore' | 'resize' | 'manual'
	*/
	rebase(reason = "manual") {
		const _ = this;
		_._refreshMaxScroll();
		const y = clamp(_._rawY(), 0, _._maxScrollY);
		_._lastScrollY = y;
		_._lastEventY = y;
		_._emit("rebase", reason);
		_.tick();
	},
	/**
	* Opens a window in which scroll deltas are reported as zero. Public because
	* a consumer that knows it is about to move the page (a programmatic scroll,
	* a layout swap) can suppress the phantom gesture that follows.
	*/
	quiet() {
		this._quietUntil = this._now() + 100;
	},
	/** Wakes the rAF loop without a scroll. */
	tick() {
		const _ = this;
		if (!_._listening) return;
		if (_._rafId !== null) return;
		if (typeof requestAnimationFrame !== "function") return;
		_._rafId = requestAnimationFrame(_.handlers.frame);
	},
	/**
	* @param {object} sub - The subscription record
	*/
	_unsubscribe(sub) {
		const _ = this;
		if (!sub.active) return;
		sub.active = false;
		const index = _._subs.indexOf(sub);
		if (index !== -1) _._subs.splice(index, 1);
		if (_._subs.length === 0) _._stop();
	},
	_start() {
		const _ = this;
		if (_._listening) return;
		ViewportMetrics.init();
		ViewportMetrics.refresh();
		const h = _.handlers;
		h.frame = h.frame || _.onFrame.bind(_);
		h.scroll = h.scroll || _.onScroll.bind(_);
		h.rest = h.rest || _.onRest.bind(_);
		h.resize = h.resize || _.onResize.bind(_);
		h.restore = h.restore || _.onRestore.bind(_);
		h.motionPreference = h.motionPreference || _.onMotionPreference.bind(_);
		window.addEventListener("scroll", h.scroll, { passive: true });
		window.addEventListener("scrollend", h.rest, { passive: true });
		window.addEventListener("resize", h.resize, { passive: true });
		window.visualViewport?.addEventListener("resize", h.resize, { passive: true });
		window.addEventListener("load", h.restore, { passive: true });
		window.addEventListener("pageshow", h.restore, { passive: true });
		_._motionQuery()?.addEventListener?.("change", h.motionPreference);
		_._listening = true;
		_._refreshMaxScroll();
		_._lastScrollY = _._lastEventY = clamp(_._rawY(), 0, _._maxScrollY);
		_._lastWidth = _._width();
		_._lastEventTime = 0;
		_._lastFrameTime = 0;
		_._rebaseOnNextScroll = typeof document !== "undefined" && document.readyState !== "complete";
	},
	_stop() {
		const _ = this;
		const h = _.handlers;
		if (_._listening) {
			window.removeEventListener("scroll", h.scroll);
			window.removeEventListener("scrollend", h.rest);
			window.removeEventListener("resize", h.resize);
			window.visualViewport?.removeEventListener("resize", h.resize);
			window.removeEventListener("load", h.restore);
			window.removeEventListener("pageshow", h.restore);
			_._motionQuery()?.removeEventListener?.("change", h.motionPreference);
		}
		clearTimeout(_._idleTimer);
		if (_._rafId !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(_._rafId);
		_._idleTimer = null;
		_._rafId = null;
		_._listening = false;
		_._velocity = 0;
		_._lastFrameTime = 0;
		_._lastEventTime = 0;
		_._quietUntil = 0;
		_._restPending = false;
		_._rebaseOnNextScroll = false;
	},
	onScroll() {
		const _ = this;
		const now = _._now();
		if (_._rebaseOnNextScroll) {
			_._rebaseOnNextScroll = false;
			_.rebase("restore");
		} else if (!_._restPending) _._refreshMaxScroll();
		const raw = _._rawY();
		if (raw > _._maxScrollY) _._refreshMaxScroll();
		const y = clamp(raw, 0, _._maxScrollY);
		const delta = now < _._quietUntil ? 0 : y - _._lastEventY;
		_._lastEventY = y;
		if (_.reducedMotion) _._velocity = 0;
		else {
			const eventDt = _._lastEventTime > 0 ? clamp(now - _._lastEventTime, 0, 64) : REFERENCE_FRAME_MS;
			const factor = 1 - Math.exp(-eventDt / EMA_TAU);
			_._velocity = clamp(_._velocity + (delta - _._velocity) * factor, -100, 100);
		}
		_._lastEventTime = now;
		_._armIdle();
		_.tick();
	},
	/**
	* True scroll rest. Reached from native `scrollend` and from the IDLE_MS
	* fallback timer; both land here and the work is idempotent, so whichever
	* arrives first reports rest and the other is a no-op.
	*/
	onRest() {
		const _ = this;
		clearTimeout(_._idleTimer);
		_._idleTimer = null;
		if (!_._restPending) return;
		_._restPending = false;
		_._emit("rest");
		_.tick();
	},
	/** Scroll restoration / bfcache return: adopt the position, no delta. */
	onRestore() {
		this._rebaseOnNextScroll = false;
		this.rebase("restore");
	},
	onResize() {
		const _ = this;
		const width = _._width();
		const widthChanged = width !== _._lastWidth;
		_._lastWidth = width;
		const refreshed = ViewportMetrics.refresh();
		const metrics = {
			currentHeight: refreshed.currentHeight,
			stableHeight: refreshed.stableHeight
		};
		_._refreshMaxScroll();
		if (widthChanged || _.quietOnHeightResize) {
			_.quiet();
			_.rebase("resize");
		}
		_._emit("resize", metrics);
		_.tick();
	},
	onMotionPreference() {
		this._velocity = 0;
		this.tick();
	},
	_armIdle() {
		const _ = this;
		_._restPending = true;
		clearTimeout(_._idleTimer);
		_._idleTimer = setTimeout(_.handlers.rest, 120);
	},
	/**
	* One frame. Reads first, computes, then dispatches — every subscriber sees
	* the same numbers, and no callback can invalidate a read for the next one.
	* @param {number} now - rAF timestamp
	*/
	onFrame(now) {
		const _ = this;
		_._rafId = null;
		const rawY = _._rawY();
		if (rawY > _._maxScrollY) _._refreshMaxScroll();
		const y = clamp(rawY, 0, _._maxScrollY);
		const quiet = now < _._quietUntil;
		let delta = y - _._lastScrollY;
		_._lastScrollY = y;
		if (quiet) delta = 0;
		const dt = _._lastFrameTime > 0 ? clamp(now - _._lastFrameTime, 0, 64) : 16;
		_._lastFrameTime = now;
		const reduced = _.reducedMotion;
		if (delta !== 0) _._armIdle();
		if (reduced) _._velocity = 0;
		else {
			_._velocity *= Math.exp(-dt / VELOCITY_DECAY_TAU);
			if (Math.abs(_._velocity) < .01) _._velocity = 0;
		}
		const packet = {
			y,
			rawY,
			delta,
			velocity: _._velocity,
			dt,
			now,
			quiet,
			reducedMotion: reduced
		};
		let wantsFrame = false;
		const subs = _._subs.slice();
		for (const sub of subs) {
			if (!sub.active) continue;
			if (safeCall(sub.frame, packet) === true) wantsFrame = true;
		}
		if (_._velocity !== 0 || delta !== 0 || wantsFrame) _.tick();
		else _._lastFrameTime = 0;
	},
	/**
	* @param {string} name - Callback name on the subscription record
	* @param {*} [arg] - Single argument to pass
	*/
	_emit(name, arg) {
		const subs = this._subs.slice();
		for (const sub of subs) {
			if (!sub.active) continue;
			safeCall(sub[name], arg);
		}
	},
	_refreshMaxScroll() {
		const doc = typeof document !== "undefined" ? document.documentElement : null;
		const height = doc ? doc.scrollHeight : 0;
		const viewport = typeof window !== "undefined" ? window.innerHeight || 0 : 0;
		this._maxScrollY = Math.max(0, height - viewport);
	},
	/** @returns {number} Unclamped `window.scrollY`. */
	_rawY() {
		const y = typeof window === "undefined" ? 0 : window.scrollY;
		return Number.isFinite(y) ? y : 0;
	},
	/** @returns {number} Layout viewport width, the resize classifier's input. */
	_width() {
		return typeof window === "undefined" ? 0 : window.innerWidth || 0;
	},
	/**
	* `performance.now()` shares its time origin with the rAF timestamp, so the
	* quiet window (opened from an event, tested from a frame) can compare the
	* two directly.
	* @returns {number} Milliseconds on the shared clock
	*/
	_now() {
		return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
	},
	/**
	* Resolved once, at first use rather than at import — the module must be
	* importable without a DOM, and a test needs to stub `matchMedia` before it
	* is read.
	* @returns {object | null} The media query list, or null where unsupported
	*/
	_motionQuery() {
		if (this._rmq === void 0) this._rmq = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
		return this._rmq;
	},
	/** Test hook: tear everything down and forget every cached global. */
	_reset() {
		const _ = this;
		for (const sub of _._subs.slice()) sub.active = false;
		_._subs.length = 0;
		_._stop();
		_.handlers = {};
		_._rmq = void 0;
		_._lastScrollY = 0;
		_._lastEventY = 0;
		_._maxScrollY = 0;
		_._lastWidth = 0;
		_.quietOnHeightResize = false;
	}
};
var SHOW_DURATION_SCALE = .85;
var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
var ScrollEngine = {
	header: null,
	riders: /* @__PURE__ */ new Set(),
	offset: 0,
	published: 0,
	motion: "idle",
	y: 0,
	lastWritten: null,
	reducedAnchor: 0,
	revealAnchor: 0,
	stopsDirty: false,
	restDue: false,
	settle: null,
	/** @type {object | null} The ScrollHandler subscription. */
	sub: null,
	pendingEvents: [],
	state: {
		scroll: null,
		hidden: null,
		revealed: null,
		tracking: null,
		locked: null
	},
	handlers: {},
	/**
	* The offset CSS is currently resolving against — the last value actually
	* WRITTEN to `--header-group-offset`, not the raw one just computed.
	*
	* Everything that takes an applied transform back OUT of a measured rect has
	* to use this. The two numbers are close with smoothing off (they differ by
	* the write epsilon, and by a re-clamp that lands between frames) and openly
	* different with it on, where the raw offset runs 1:1 while the published one
	* eases behind it. Subtracting a translate the browser has not applied is how
	* the pinned test starts oscillating and riders start flickering.
	* @returns {number} Applied offset in px
	*/
	get appliedOffset() {
		return this.lastWritten === null ? 0 : this.lastWritten;
	},
	/**
	* Registers the single <sticky-header>. A second host is rejected — the
	* engine writes one global offset, so two would fight over it.
	* @param {HTMLElement} header - The host element
	* @returns {boolean} True when this host became the primary
	*/
	registerHeader(header) {
		if (this.header && this.header !== header) {
			console.warn("<sticky-header> only one instance can be active — the extra instance is inert");
			return false;
		}
		this.header = header;
		this.offset = 0;
		this.published = 0;
		this.lastWritten = null;
		this.settle = null;
		this.motion = "idle";
		this.revealAnchor = 0;
		this.restDue = false;
		this.start();
		ScrollHandler.rebase();
		this.tick();
		return true;
	},
	/**
	* Releases the primary host and clears everything it wrote to <body>.
	* @param {HTMLElement} header - The host element
	*/
	unregisterHeader(header) {
		if (this.header !== header) return;
		this.header = null;
		this.offset = 0;
		this.published = 0;
		this.settle = null;
		this.motion = "idle";
		this.restDue = false;
		this.pendingEvents.length = 0;
		this._clearBody();
		if (!this.riders.size) this.stop();
	},
	/**
	* Registers a <sticky-content> rider. Riders get a per-frame `[stuck]`
	* check and keep working (as plain sticky elements) with no header present.
	* @param {HTMLElement} rider - The rider element
	*/
	registerRider(rider) {
		this.riders.add(rider);
		this.start();
		this.tick();
	},
	/**
	* @param {HTMLElement} rider - The rider element
	*/
	unregisterRider(rider) {
		this.riders.delete(rider);
		if (!this.riders.size && !this.header) this.stop();
	},
	/** Subscribes to the scroll signal. The first consumer starts the handler. */
	start() {
		const _ = this;
		if (_.sub) return;
		_.handlers.frame = _.handlers.frame || _.onFrame.bind(_);
		_.handlers.rest = _.handlers.rest || _.onRest.bind(_);
		_.handlers.rebase = _.handlers.rebase || _.onRebase.bind(_);
		_.handlers.resize = _.handlers.resize || _.onResize.bind(_);
		_.handlers.motionPreference = _.handlers.motionPreference || _.onMotionPreference.bind(_);
		reducedMotion.addEventListener("change", _.handlers.motionPreference);
		_.sub = ScrollHandler.subscribe({
			frame: _.handlers.frame,
			rest: _.handlers.rest,
			rebase: _.handlers.rebase,
			resize: _.handlers.resize
		});
		_.y = ScrollHandler.y;
		_.reducedAnchor = _.y;
	},
	stop() {
		const _ = this;
		reducedMotion.removeEventListener("change", _.handlers.motionPreference);
		_.sub?.unsubscribe();
		_.sub = null;
		_.motion = "idle";
		_.restDue = false;
	},
	/** Wakes the rAF loop without a scroll — used by observers and the API. */
	tick() {
		this.sub?.tick();
	},
	/**
	* Re-anchors scroll tracking to the current position, producing no delta.
	* Goes through the handler, which owns the delta base — the engine's own
	* anchors are then rebuilt in onRebase(), the single place that does it.
	*/
	rebase() {
		ScrollHandler.rebase();
	},
	/**
	* The position was adopted with no gesture behind it.
	* @param {string} reason - 'restore' | 'resize' | 'manual'
	*/
	onRebase(reason) {
		const _ = this;
		_.y = ScrollHandler.y;
		_.reducedAnchor = _.y;
		_.revealAnchor = _.y + _.offset;
		if (reason !== "restore") return;
		if (_._glideMode()) {
			_.settle = null;
			_.motion = "idle";
			_.revealAnchor = 0;
		} else _.requestSettle(0, {
			reason: "show",
			forced: true
		});
	},
	onResize() {
		this.header?._measure();
		for (const rider of this.riders) rider._invalidateTop();
	},
	onMotionPreference() {
		this.settle = null;
		this.motion = "idle";
		ScrollHandler.rebase();
	},
	/**
	* True scroll rest, as the handler defines it: movement has actually stopped,
	* not merely the scroll events. Idempotent — `scrollend` and the handler's
	* fallback both land here and whichever arrives first does the work.
	*
	* No trailing tick: the handler ticks immediately after emitting this.
	*/
	onRest() {
		const _ = this;
		if (_.motion === "settling") return;
		_.motion = "idle";
		_.restDue = false;
		_._settleToStop(_._trackable());
	},
	/**
	* Settles onto the stop the current position belongs at. Shared by the two
	* things that ask that question: a true scroll rest, and a settle that has
	* just landed somewhere the resting rules would not have chosen.
	* @param {boolean} trackable - Whether direction-based tracking applies
	*/
	_settleToStop(trackable) {
		const header = this.header;
		if (!header) return;
		if (header._geometry.groupHeight <= 0 || !trackable) return;
		const target = this._settleTarget();
		this.requestSettle(target, { reason: target < this.offset ? "hide" : "show" });
	},
	/**
	* The stop an idle mid-page settle commits to. The threshold operates
	* between the two BRACKETING stops — hidden and the reveal boundary — not
	* over the full travel, so a partial boundary moves the commit point with
	* it. With nothing tagged the upper stop is 0 and this is the original
	* hidden-fraction test exactly.
	*
	* When the boundary sits at the bottom of the group (tagged elements exist
	* but none apply here) the two stops coincide: mid-page there is only one
	* legal resting place, and it is hidden.
	* @returns {number} Target offset in px
	*/
	_settleTarget() {
		const header = this.header;
		const { groupHeight, topOnlyHeight } = header._geometry;
		const upper = -topOnlyHeight;
		const travel = groupHeight - topOnlyHeight;
		let target;
		if (travel <= 0) target = -groupHeight;
		else target = clamp((upper - this.offset) / travel, 0, 1) > header._config.settleThreshold ? -groupHeight : upper;
		return Math.max(target, -this.y);
	},
	/**
	* Marks the resting stops stale — a breakpoint change re-resolving which tags
	* are active, a tag edited live, or a re-measure moving the boundary. The
	* work itself happens in the next frame's COMPUTE phase, where the pinned and
	* trackable reads for this frame already exist: deciding here instead would
	* mean a rect read straight after the caller's style writes.
	*/
	onStopsChanged() {
		this.stopsDirty = true;
		this.tick();
	},
	/**
	* Re-settles onto the correct stop for the current mode. Compute-phase only —
	* every input is already read.
	* @param {number} y - Clamped scroll position
	* @param {boolean} glide - Whether the position-based mode applies
	* @param {boolean} trackable - Whether direction-based tracking applies
	*/
	_applyStops(y, glide, trackable) {
		const { groupHeight, topOnlyHeight } = this.header._geometry;
		if (groupHeight <= 0) return;
		if (glide) {
			this.settle = null;
			this.motion = "idle";
			this.offset = clamp(this.offset, -topOnlyHeight, 0);
			this.revealAnchor = y + this.offset;
		} else if (this.motion !== "settling") {
			const target = trackable ? this._settleTarget() : 0;
			this.requestSettle(target, {
				reason: target < this.offset ? "hide" : "show",
				forced: true
			});
		}
	},
	/**
	* Starts a settle tween toward `to`, unless one with the same intent is
	* already running or the offset is already there.
	* @param {number} to - Target offset in px
	* @param {object} options - `reason` ('show'|'hide') and `forced`
	*/
	requestSettle(to, { reason = to < 0 ? "hide" : "show", forced = false } = {}) {
		const _ = this;
		if (_.published !== _.offset) _.offset = _.published;
		const settle = _.settle;
		if (settle && settle.to === to) {
			if (forced) settle.forced = true;
			return;
		}
		if (!settle && Math.abs(_.offset - to) <= .05) {
			_.offset = to;
			return;
		}
		const header = _.header;
		const config = header ? header._config : null;
		if (reducedMotion.matches) {
			_.settle = null;
			_.offset = to;
			_.motion = "idle";
			_.reducedAnchor = _.y;
			return;
		}
		const base = config ? config.settleDuration : 900;
		const duration = Math.max(1, reason === "show" ? base * SHOW_DURATION_SCALE : base);
		_.settle = {
			from: _.offset,
			to,
			reason,
			forced,
			duration,
			start: null,
			ease: makeSettleEase(config ? config.settleOvershoot : .05)
		};
		_.motion = "settling";
		_.queueEvent("settle", {
			target: reason,
			from: _.settle.from,
			duration
		});
		_.tick();
	},
	cancelSettle() {
		if (!this.settle) return;
		this.settle = null;
		this.motion = "tracking";
	},
	/**
	* Re-clamps the offset (and any in-flight settle) into a changed range.
	* Called after a re-measure — an announcement dismissed while the header is
	* hidden shrinks the group, and everything parked past the new range has to
	* come back into it, including a tween already aimed at the old bound.
	* @param {number} groupHeight - The new group height
	*/
	reclamp(groupHeight) {
		this.offset = clamp(this.offset, -groupHeight, 0);
		this.published = clamp(this.published, -groupHeight, 0);
		const settle = this.settle;
		if (!settle) return;
		settle.to = clamp(settle.to, -groupHeight, 0);
		settle.from = clamp(settle.from, -groupHeight, 0);
	},
	/**
	* Queues an event for dispatch in the write phase.
	* @param {string} name - Event name after the `sticky-header:` prefix
	* @param {object} detail - Event detail payload
	*/
	queueEvent(name, detail) {
		this.pendingEvents.push({
			name,
			detail
		});
	},
	flushEvents() {
		if (!this.pendingEvents.length) return;
		const header = this.header;
		const queued = this.pendingEvents.splice(0, this.pendingEvents.length);
		if (!header) return;
		for (const { name, detail } of queued) header._emit(name, detail);
	},
	/**
	* Whether the group has reached its pinned position. Tested against the
	* UNtranslated top — `rect.top` already carries the transform, so the applied
	* offset has to be taken back out of it or the check oscillates on the show
	* overshoot, where a positive offset drags the rect below `stickyTop`.
	*
	* It is `appliedOffset`, not the raw one: the rect reflects the last value
	* CSS was given, which under tracking-smoothing is a different number.
	*
	* The host may or may not BE the translating element, though: the documented
	* `position: fixed` workaround sets `transform: none` here and moves the
	* translate to an inner element, and then the rect carries no offset to
	* undo — subtracting one anyway makes the test false the whole time the
	* header is hidden, which force-shows it every frame. The package rule
	* always resolves to a matrix (even at offset 0, `translateY(0px)` computes
	* to one), so a computed `none` identifies that workaround exactly.
	*
	* Read per frame rather than cached: the rule can be breakpoint-dependent,
	* and a cache would have to be refreshed from wherever CSS might change.
	* It sits beside a rect read either way — in the frame's read phase, or off
	* it via onRest() → _trackable() — so it adds no thrash of its own.
	* @returns {boolean} True while the group is pinned
	*/
	_pinned() {
		const header = this.header;
		if (!header) return false;
		const rect = header.getBoundingClientRect();
		const applied = getComputedStyle(header).transform === "none" ? 0 : this.appliedOffset;
		return rect.top - applied <= header._geometry.stickyTop + .5;
	},
	/**
	* Whether ANY mode could move the group right now. Purely config and
	* geometry — it is what keeps the per-frame rect read out of a page where
	* the header can't move at all.
	* @param {boolean} glide - Whether the glide mode applies this frame
	* @returns {boolean} True when a rect read is worth taking
	*/
	_movable(glide) {
		const header = this.header;
		if (!header) return false;
		if (header._geometry.groupHeight <= 0) return false;
		return glide || header._isActive();
	},
	/**
	* The position-based glide: hide-on-scroll is OFF here, but a reveal
	* boundary exists, so everything above it leaves with the page instead of
	* staying pinned. Gated on a boundary strictly INSIDE the group — a
	* boundary at the very bottom (nothing active here) would glide the header
	* away too, on a viewport whose whole point is that it never hides.
	* @returns {boolean} True when the offset is position-based this frame
	*/
	_glideMode() {
		const header = this.header;
		if (!header) return false;
		if (header.hasAttribute("disabled")) return false;
		if (header._isActive()) return false;
		if (header._isLocked()) return false;
		const { groupHeight, topOnlyHeight } = header._geometry;
		return topOnlyHeight > 0 && topOnlyHeight < groupHeight;
	},
	/**
	* Whether the header is currently allowed to move at all.
	* @param {boolean} [pinned] - Pinned test result, when already read this frame
	* @returns {boolean} True while direction-based tracking applies
	*/
	_trackable(pinned) {
		const header = this.header;
		if (!header) return false;
		if (!header._isActive()) return false;
		if (header._isLocked()) return false;
		if (header._geometry.groupHeight <= 0) return false;
		if (!(pinned === void 0 ? this._pinned() : pinned)) return false;
		return this.y > header._config.revealThreshold;
	},
	/**
	* The position-based offset: how far the group has travelled past the point
	* where it pinned, capped at the reveal boundary. While the group has not
	* pinned yet the anchor rides along with the scroll, so the glide always
	* starts from the exact position the group left — and reverses onto it.
	* @param {number} y - Clamped scroll position
	* @param {boolean} pinned - Whether the group is pinned this frame
	* @param {number} topOnlyHeight - Distance from the group top to the boundary
	* @returns {number} Offset in px
	*/
	_glideOffset(y, pinned, topOnlyHeight) {
		if (!pinned) {
			this.revealAnchor = y;
			return 0;
		}
		return -clamp(y - this.revealAnchor, 0, topOnlyHeight);
	},
	/**
	* Advances an in-flight settle tween by one frame.
	* @param {number} now - rAF timestamp
	*/
	_stepSettle(now) {
		const settle = this.settle;
		if (settle.start === null) settle.start = now;
		const t = clamp((now - settle.start) / settle.duration, 0, 1);
		this.offset = settle.from + (settle.to - settle.from) * settle.ease(t);
		if (t >= 1) {
			this.offset = settle.to;
			this.settle = null;
			this.motion = "idle";
			this.restDue = true;
		}
	},
	/**
	* One frame of the scroll signal. Strict read → compute → write.
	* @param {object} packet - The handler's per-frame packet
	* @returns {boolean} True to ask the handler for another frame
	*/
	onFrame(packet) {
		const _ = this;
		const { y, delta, dt, now } = packet;
		const reduced = packet.reducedMotion;
		_.y = y;
		const header = _.header;
		header?._readReveal();
		const glide = _._glideMode();
		const pinned = _._movable(glide) ? _._pinned() : false;
		const trackable = _._trackable(pinned);
		const riderReads = _._readRiders();
		if (header) {
			const { groupHeight, topOnlyHeight } = header._geometry;
			if (_.stopsDirty) {
				_.stopsDirty = false;
				_._applyStops(y, glide, trackable);
			}
			if (_.restDue && delta === 0 && _.motion !== "settling") {
				_.restDue = false;
				_._settleToStop(trackable);
			}
			if (reduced) {
				if (glide) _.offset = _._glideOffset(y, pinned, topOnlyHeight);
				else if (!trackable) {
					_.offset = 0;
					_.reducedAnchor = y;
				} else {
					const drift = y - _.reducedAnchor;
					if (Math.abs(drift) >= 5) {
						_.offset = drift > 0 ? -groupHeight : -topOnlyHeight;
						_.reducedAnchor = y;
					}
				}
				_.motion = "idle";
			} else if (glide) {
				if (_.settle) {
					_._stepSettle(now);
					_.revealAnchor = y + _.offset;
				} else {
					_.offset = _._glideOffset(y, pinned, topOnlyHeight);
					if (delta !== 0) _.motion = "tracking";
				}
			} else {
				if (!trackable) _.requestSettle(0, {
					reason: "show",
					forced: true
				});
				else if (_.settle && !_.settle.forced && Math.abs(delta) >= 1) _.cancelSettle();
				if (_.settle) _._stepSettle(now);
				else if (trackable && delta !== 0) {
					const ceiling = Math.min(0, Math.max(-topOnlyHeight, _.offset));
					_.offset = clamp(_.offset - delta, -groupHeight, ceiling);
					_.motion = "tracking";
				}
			}
			if (_.offset < -y) _.offset = -y;
			if (!glide) _.revealAnchor = y + _.offset;
			const tau = _.motion === "tracking" ? header._config.trackingSmoothing : 0;
			_.published = expApproach(_.published, _.offset, dt, tau);
		}
		header?._writeReveal();
		_._writeOffset();
		_._syncState(y);
		_._writeRiders(riderReads);
		_.flushEvents();
		return _.motion === "settling" || _.motion === "tracking" && delta !== 0 || _.restDue || Math.abs(_.published - _.offset) > .05;
	},
	_writeOffset() {
		if (!this.header) return;
		const offset = this.published;
		const settled = this.motion === "idle";
		if (this.lastWritten !== null && !settled && Math.abs(offset - this.lastWritten) <= .05) return;
		if (this.lastWritten === offset) return;
		this.lastWritten = offset;
		document.body.style.setProperty("--header-group-offset", `${offset}px`);
	},
	_syncState(y) {
		const header = this.header;
		if (!header) return;
		const body = document.body;
		const state = this.state;
		const { groupHeight, topOnlyHeight } = header._geometry;
		const scrollState = y <= 8 ? "top" : "scrolling";
		if (scrollState !== state.scroll) {
			state.scroll = scrollState;
			body.setAttribute("data-state", scrollState);
		}
		const locked = header._isLocked();
		if (locked !== state.locked) {
			state.locked = locked;
			body.toggleAttribute("data-header-locked", locked);
		}
		const tracking = this.motion !== "idle";
		if (tracking !== state.tracking) {
			state.tracking = tracking;
			body.toggleAttribute("data-header-tracking", tracking);
			header.toggleAttribute("data-tracking", tracking);
		}
		if (this.motion === "idle") {
			const hidden = groupHeight > 0 && this.offset <= -groupHeight + .05;
			if (hidden !== state.hidden) {
				const first = state.hidden === null;
				state.hidden = hidden;
				body.toggleAttribute("data-header-hidden", hidden);
				header.toggleAttribute("data-hidden", hidden);
				if (!first) header._emit(hidden ? "hide" : "show", {});
			}
			const revealed = topOnlyHeight > 0 && topOnlyHeight < groupHeight && Math.abs(this.offset + topOnlyHeight) <= .05;
			if (revealed !== state.revealed) {
				const first = state.revealed === null;
				state.revealed = revealed;
				body.toggleAttribute("data-header-revealed", revealed);
				if (revealed && !first) header._emit("reveal", {});
			}
		}
	},
	_readRiders() {
		if (!this.riders.size) return null;
		const offset = this.header ? this.appliedOffset : 0;
		const reads = [];
		for (const rider of this.riders) {
			if (rider.hasAttribute("disabled")) {
				reads.push({
					rider,
					stuck: false
				});
				continue;
			}
			const effectiveTop = rider._baseTop() + offset;
			reads.push({
				rider,
				stuck: rider.getBoundingClientRect().top <= effectiveTop + .5
			});
		}
		return reads;
	},
	_writeRiders(reads) {
		if (!reads) return;
		for (const { rider, stuck } of reads) if (stuck !== rider.hasAttribute("stuck")) rider.toggleAttribute("stuck", stuck);
	},
	_clearBody() {
		const body = document.body;
		body.style.removeProperty("--header-group-offset");
		body.style.removeProperty("--header-group-height");
		body.style.removeProperty("--header-height");
		body.style.removeProperty("--announcement-bar-height");
		body.style.removeProperty("--header-reveal-offset");
		body.removeAttribute("data-state");
		body.removeAttribute("data-header-hidden");
		body.removeAttribute("data-header-revealed");
		body.removeAttribute("data-header-tracking");
		body.removeAttribute("data-header-locked");
		this.state = {
			scroll: null,
			hidden: null,
			revealed: null,
			tracking: null,
			locked: null
		};
		this.lastWritten = null;
	}
};
//#endregion
//#region src/components/sticky-header.js
var DEFAULTS = {
	hideOnScroll: "both",
	breakpoint: 1024,
	revealThreshold: 100,
	settleThreshold: .5,
	settleDuration: 900,
	settleOvershoot: .05,
	trackingSmoothing: 0
};
var HIDE_MODES = [
	"none",
	"mobile",
	"desktop",
	"both"
];
var HEIGHT_EPSILON = 1;
var REVEAL_ATTRIBUTE = "data-sticky-reveal";
var warnedRevealValues = /* @__PURE__ */ new Set();
/**
* @param {NodeList} nodes - Mutation record node list
* @returns {boolean} Whether it contains an element node
*/
function hasElement(nodes) {
	for (const node of nodes) if (node.nodeType === 1) return true;
	return false;
}
/**
* Parses a numeric attribute, falling back to a default and clamping to range.
* @param {string|null} value - Raw attribute value
* @param {number} fallback - Default when absent or unparseable
* @param {number} min - Lower bound
* @param {number} max - Upper bound
* @returns {number} Parsed number
*/
function parseNumber(value, fallback, min, max) {
	const parsed = parseFloat(value);
	if (!Number.isFinite(parsed)) return fallback;
	return clamp(parsed, min, max);
}
/**
* Scroll-following sticky header. Tracks the scroll 1:1 and settles to fully
* shown or fully hidden when scrolling stops.
*/
var StickyHeader = class extends HTMLElement {
	#config = { ...DEFAULTS };
	#geometry = {
		headerHeight: 0,
		announcementHeight: 0,
		groupHeight: 0,
		stickyTop: 0,
		topOnlyHeight: 0
	};
	#announcementElement = null;
	#mediaQuery = null;
	#resizeObserver = null;
	#lockObserver = null;
	#revealObserver = null;
	#lockState = false;
	#lockDirty = true;
	#revealDirty = true;
	#revealPending = false;
	#revealPublished = null;
	#revealRaw = 0;
	#initialized = false;
	#measured = false;
	#hoverQuery = null;
	#hovered = false;
	handlers = {};
	static get observedAttributes() {
		return [
			"hide-on-scroll",
			"breakpoint",
			"reveal-threshold",
			"settle-threshold",
			"settle-duration",
			"settle-overshoot",
			"tracking-smoothing",
			"lock",
			"locked",
			"disabled",
			"hover-lock"
		];
	}
	connectedCallback() {
		if (document.readyState === "loading") {
			if (this.handlers.ready) return;
			this.handlers.ready = () => {
				this.handlers.ready = null;
				this.#init();
			};
			document.addEventListener("DOMContentLoaded", this.handlers.ready, { once: true });
			return;
		}
		this.#init();
	}
	disconnectedCallback() {
		const _ = this;
		if (_.handlers.ready) {
			document.removeEventListener("DOMContentLoaded", _.handlers.ready);
			_.handlers.ready = null;
		}
		if (!_.#initialized) return;
		_.#initialized = false;
		_.#resizeObserver?.disconnect();
		_.#resizeObserver = null;
		_.#lockObserver?.disconnect();
		_.#lockObserver = null;
		_.#revealObserver?.disconnect();
		_.#revealObserver = null;
		_.#mediaQuery?.removeEventListener("change", _.handlers.media);
		_.#mediaQuery = null;
		_.removeEventListener("pointerenter", _.handlers.pointerEnter);
		_.removeEventListener("pointerleave", _.handlers.pointerLeave);
		_.#hovered = false;
		_.#hoverQuery = null;
		_.removeAttribute("data-hidden");
		_.removeAttribute("data-tracking");
		_.#measured = false;
		_.#geometry = {
			headerHeight: 0,
			announcementHeight: 0,
			groupHeight: 0,
			stickyTop: 0,
			topOnlyHeight: 0
		};
		_.#lockDirty = true;
		_.#revealDirty = true;
		_.#revealPending = false;
		_.#revealPublished = null;
		_.#revealRaw = 0;
		ScrollEngine.unregisterHeader(_);
	}
	attributeChangedCallback(name, previousValue, currentValue) {
		if (!this.#initialized || previousValue === currentValue) return;
		if (name === "lock") {
			this.#lockDirty = true;
			this.#observeLocks();
		} else if (name === "breakpoint" || name === "hide-on-scroll") {
			this.#parseConfig();
			this.#observeMedia();
			ScrollEngine.rebase();
			this.#revealDirty = true;
			this._readReveal();
			this._writeReveal();
			ScrollEngine.onStopsChanged();
		} else if (name === "locked") this.#lockDirty = true;
		else this.#parseConfig();
		ScrollEngine.tick();
	}
	#init() {
		const _ = this;
		if (_.#initialized) return;
		_.#parseConfig();
		if (!ScrollEngine.registerHeader(_)) return;
		_.#initialized = true;
		_.queryDOM();
		_.attachListeners();
		_.#hoverQuery = window.matchMedia("(hover: hover) and (pointer: fine)");
		_.addEventListener("pointerenter", _.handlers.pointerEnter);
		_.addEventListener("pointerleave", _.handlers.pointerLeave);
		_.#observeMedia();
		_.#observeTargets();
		_.#observeLocks();
		_.#observeReveal();
		_._measure();
		ScrollEngine.tick();
	}
	queryDOM() {
		this.#announcementElement = this.querySelector("[data-announcement]");
	}
	attachListeners() {
		const _ = this;
		_.handlers.media = _.handlers.media || _.#onMediaChange.bind(_);
		_.handlers.lockMutation = _.handlers.lockMutation || _.#onLockMutation.bind(_);
		_.handlers.revealMutation = _.handlers.revealMutation || _.#onRevealMutation.bind(_);
		_.handlers.resizeObserved = _.handlers.resizeObserved || (() => _._measure());
		_.handlers.pointerEnter = _.handlers.pointerEnter || _.#onPointerEnter.bind(_);
		_.handlers.pointerLeave = _.handlers.pointerLeave || _.#onPointerLeave.bind(_);
	}
	#onPointerEnter() {
		this.#hovered = true;
		ScrollEngine.tick();
	}
	#onPointerLeave() {
		this.#hovered = false;
		ScrollEngine.tick();
	}
	/**
	* Whether the pointer is parked in the header group with hover-lock on.
	* Gated to hover-capable fine pointers — on touch, `pointerenter` sticks
	* after a tap and would wedge the header permanently open.
	* @returns {boolean} True while hover should hold the header visible
	*/
	#isHoverLocked() {
		if (!this.hasAttribute("hover-lock")) return false;
		if (!this.#hovered) return false;
		return this.#hoverQuery ? this.#hoverQuery.matches : false;
	}
	#parseConfig() {
		const _ = this;
		const mode = (_.getAttribute("hide-on-scroll") || "").toLowerCase();
		_.#config = {
			hideOnScroll: HIDE_MODES.includes(mode) ? mode : DEFAULTS.hideOnScroll,
			breakpoint: parseNumber(_.getAttribute("breakpoint"), DEFAULTS.breakpoint, 1, 1e5),
			revealThreshold: parseNumber(_.getAttribute("reveal-threshold"), DEFAULTS.revealThreshold, 0, 1e5),
			settleThreshold: parseNumber(_.getAttribute("settle-threshold"), DEFAULTS.settleThreshold, 0, 1),
			settleDuration: parseNumber(_.getAttribute("settle-duration"), DEFAULTS.settleDuration, 1, 5e3),
			settleOvershoot: parseNumber(_.getAttribute("settle-overshoot"), DEFAULTS.settleOvershoot, 0, .2),
			trackingSmoothing: parseNumber(_.getAttribute("tracking-smoothing"), DEFAULTS.trackingSmoothing, 0, 1e3)
		};
	}
	#observeMedia() {
		const _ = this;
		_.#mediaQuery?.removeEventListener("change", _.handlers.media);
		_.#mediaQuery = window.matchMedia(`(min-width: ${_.#config.breakpoint}px)`);
		_.#mediaQuery.addEventListener("change", _.handlers.media);
	}
	#onMediaChange() {
		const _ = this;
		ScrollEngine.rebase();
		_.#revealDirty = true;
		_._readReveal();
		_._writeReveal();
		ScrollEngine.onStopsChanged();
		ScrollEngine.tick();
	}
	#observeReveal() {
		const _ = this;
		_.#revealObserver?.disconnect();
		_.#revealObserver = new MutationObserver(_.handlers.revealMutation);
		_.#revealObserver.observe(_, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: [REVEAL_ATTRIBUTE]
		});
	}
	/**
	* Marks the boundary stale. Deliberately does NO measuring: this runs at
	* microtask time, so a rect read here would force layout outside any frame,
	* on churn the component did not ask about. The engine picks the work up in
	* its read phase.
	* @param {MutationRecord[]} records - Batched mutation records
	*/
	#onRevealMutation(records) {
		let relevant = false;
		for (const record of records) if (record.type === "attributes" || hasElement(record.addedNodes) || hasElement(record.removedNodes)) {
			relevant = true;
			break;
		}
		if (!relevant) return;
		this.#revealDirty = true;
		ScrollEngine.tick();
	}
	#observeTargets() {
		const _ = this;
		_.#resizeObserver?.disconnect();
		if (!("ResizeObserver" in window)) return;
		_.#resizeObserver = new ResizeObserver(_.handlers.resizeObserved);
		_.#resizeObserver.observe(_);
		if (_.#announcementElement) _.#resizeObserver.observe(_.#announcementElement);
	}
	#observeLocks() {
		const _ = this;
		_.#lockObserver?.disconnect();
		const filter = /* @__PURE__ */ new Set(["open"]);
		const selector = _.getAttribute("lock");
		if (selector) {
			for (const match of selector.matchAll(/\[\s*([\w-]+)/g)) filter.add(match[1]);
			if (selector.includes(".")) filter.add("class");
		}
		_.#lockObserver = new MutationObserver(_.handlers.lockMutation);
		_.#lockObserver.observe(document.documentElement, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: [...filter]
		});
	}
	#onLockMutation() {
		this.#lockDirty = true;
		ScrollEngine.tick();
	}
	get _config() {
		return this.#config;
	}
	get _geometry() {
		return this.#geometry;
	}
	/** Whether hide-on-scroll applies at this viewport and the element is on. */
	_isActive() {
		if (this.hasAttribute("disabled")) return false;
		const mode = this.#config.hideOnScroll;
		if (mode === "none") return false;
		if (mode === "both") return true;
		const isDesktop = this.#mediaQuery ? this.#mediaQuery.matches : true;
		return mode === "desktop" ? isDesktop : !isDesktop;
	}
	/** Force-show conditions. Re-queried only when a mutation marked it dirty. */
	_isLocked() {
		if (this.hasAttribute("locked")) return true;
		if (this.#isHoverLocked()) return true;
		if (!this.#lockDirty) return this.#lockState;
		this.#lockDirty = false;
		let locked = !!document.querySelector("dialog[open]");
		const selector = this.getAttribute("lock");
		if (!locked && selector) try {
			locked = !!document.querySelector(selector);
		} catch {
			console.warn(`<sticky-header> ignoring invalid lock selector "${selector}"`);
		}
		this.#lockState = locked;
		return locked;
	}
	/**
	* Dirty-gated re-resolve of the reveal boundary. Reads only — safe to call
	* from the frame's read phase.
	*/
	_readReveal(groupHeight = this.#geometry.groupHeight) {
		const _ = this;
		if (!_.#revealDirty || !_.#initialized) return;
		_.#revealDirty = false;
		const height = _.#measureRevealHeight(groupHeight);
		if (_.#revealPublished !== null && Math.abs(height - _.#revealRaw) < HEIGHT_EPSILON) return;
		_.#revealRaw = height;
		_.#geometry.topOnlyHeight = Math.round(height);
		_.#revealPending = true;
	}
	/**
	* Publishes the reveal stop and flags the engine to re-settle onto it. Writes
	* only, and only when the boundary actually moved — the engine defers the
	* decision itself to its next compute phase, so nothing reads layout here.
	*/
	_writeReveal() {
		const _ = this;
		if (!_.#revealPending) return;
		_.#revealPending = false;
		const height = _.#geometry.topOnlyHeight;
		_.#revealPublished = height;
		document.body.style.setProperty("--header-reveal-offset", `${height === 0 ? 0 : -height}px`);
		ScrollEngine.onStopsChanged();
	}
	/**
	* UNROUNDED on purpose — _readReveal compares this against the previous raw
	* measurement, so rounding here would make every distinct value differ by a
	* full pixel and the 1px epsilon could never absorb anything. The round
	* happens once, at the publication point.
	* @returns {number} Distance from the group top to the reveal boundary, in px
	*/
	#measureRevealHeight(groupHeight) {
		const _ = this;
		const targets = _.querySelectorAll(`[${REVEAL_ATTRIBUTE}]`);
		if (!targets.length) return 0;
		const isDesktop = _.#mediaQuery ? _.#mediaQuery.matches : true;
		const hostTop = _.getBoundingClientRect().top;
		const carried = getComputedStyle(_).transform === "none" ? ScrollEngine.appliedOffset : 0;
		let boundary = null;
		for (const element of targets) {
			if (!_.#revealApplies(element.getAttribute(REVEAL_ATTRIBUTE), isDesktop)) continue;
			const rect = element.getBoundingClientRect();
			if (!rect.width && !rect.height) continue;
			const top = rect.top - hostTop - carried;
			if (boundary === null || top < boundary) boundary = top;
		}
		if (boundary === null) return groupHeight;
		return clamp(boundary, 0, groupHeight);
	}
	/**
	* @param {string|null} value - Raw `data-sticky-reveal` value
	* @param {boolean} isDesktop - Whether the breakpoint query matches
	* @returns {boolean} Whether the tag applies at this viewport
	*/
	#revealApplies(value, isDesktop) {
		const mode = (value || "").trim().toLowerCase();
		if (mode === "" || mode === "both") return true;
		if (mode === "mobile") return !isDesktop;
		if (mode === "desktop") return isDesktop;
		if (mode !== "none" && !warnedRevealValues.has(mode)) {
			warnedRevealValues.add(mode);
			console.warn(`<sticky-header> ignoring unrecognized ${REVEAL_ATTRIBUTE}="${mode}" — expected both, mobile, desktop or none`);
		}
		return false;
	}
	/**
	* Re-measures the group and republishes the height custom properties.
	* Heights are maintained at every breakpoint, even when hide-on-scroll is
	* off, so unrelated layout can always offset against the header.
	*/
	_measure() {
		const _ = this;
		if (!_.#initialized) return;
		const previousAnnouncement = _.#announcementElement;
		_.queryDOM();
		if (_.#announcementElement !== previousAnnouncement) _.#observeTargets();
		const announcementHeight = _.#announcementElement ? _.#announcementElement.offsetHeight : 0;
		const headerHeight = _.offsetHeight - announcementHeight;
		const groupHeight = announcementHeight + headerHeight;
		const resolvedTop = parseFloat(getComputedStyle(_).top);
		const stickyTop = Number.isFinite(resolvedTop) ? resolvedTop : 0;
		const previous = _.#geometry;
		const changed = Math.abs(groupHeight - previous.groupHeight) >= HEIGHT_EPSILON || Math.abs(headerHeight - previous.headerHeight) >= HEIGHT_EPSILON || Math.abs(announcementHeight - previous.announcementHeight) >= HEIGHT_EPSILON || Math.abs(stickyTop - previous.stickyTop) >= HEIGHT_EPSILON;
		_.#revealDirty = true;
		_._readReveal(groupHeight);
		if (_.#measured && !changed) {
			_._writeReveal();
			return;
		}
		_.#measured = true;
		_.#geometry = {
			headerHeight,
			announcementHeight,
			groupHeight,
			stickyTop,
			topOnlyHeight: previous.topOnlyHeight
		};
		const style = document.body.style;
		style.setProperty("--header-height", `${headerHeight}px`);
		style.setProperty("--announcement-bar-height", `${announcementHeight}px`);
		style.setProperty("--header-group-height", `${groupHeight}px`);
		ScrollEngine.reclamp(groupHeight);
		_._writeReveal();
		for (const rider of ScrollEngine.riders) rider._invalidateTop();
		_._emit("resize", {
			headerHeight,
			announcementHeight,
			groupHeight
		});
		ScrollEngine.tick();
	}
	/**
	* @param {string} name - Event name after the `sticky-header:` prefix
	* @param {object} detail - Event detail payload
	*/
	_emit(name, detail) {
		this.dispatchEvent(new CustomEvent(`sticky-header:${name}`, {
			detail,
			bubbles: true
		}));
	}
	/** Current offset in px (0 = fully shown, −groupHeight = fully hidden). */
	get offset() {
		return ScrollEngine.offset;
	}
	/** Hidden fraction over the FULL travel, 0 → 1. */
	get progress() {
		const groupHeight = this.#geometry.groupHeight;
		if (groupHeight <= 0) return 0;
		return clamp(-ScrollEngine.offset / groupHeight, 0, 1);
	}
	/**
	* The reveal stop in px — the offset the group rests at when a mid-page
	* scroll up brings the tagged layers back. `0` when nothing is tagged.
	*/
	get revealOffset() {
		const height = this.#geometry.topOnlyHeight;
		return height === 0 ? 0 : -height;
	}
	/**
	* Whether the header is settled fully hidden.
	* Named `isHidden` rather than `hidden` so it can't shadow the native
	* HTMLElement.hidden property, which is a writable boolean attribute.
	*/
	get isHidden() {
		return this.hasAttribute("data-hidden");
	}
	get groupHeight() {
		return this.#geometry.groupHeight;
	}
	/**
	* Plays the show settle. Normal resting rules resume the moment it lands, so
	* mid-page on a tagged stack the next idle tucks to the reveal stop — use
	* lock() to hold the group fully visible.
	*/
	show() {
		if (!this.#initialized) return;
		ScrollEngine.requestSettle(0, {
			reason: "show",
			forced: true
		});
		ScrollEngine.tick();
	}
	/** Settles the header fully hidden. A no-op while locked or inactive. */
	hide() {
		if (!this.#initialized) return;
		this.#lockDirty = true;
		if (this._isLocked() || !this._isActive()) return;
		ScrollEngine.requestSettle(-this.#geometry.groupHeight, {
			reason: "hide",
			forced: true
		});
		ScrollEngine.tick();
	}
	/** Force-show until unlock(). */
	lock() {
		this.setAttribute("locked", "");
	}
	unlock() {
		this.removeAttribute("locked");
	}
	/** Re-measures geometry and rebases scroll tracking. */
	refresh() {
		if (!this.#initialized) return;
		this.queryDOM();
		this.#observeTargets();
		this.#lockDirty = true;
		this._measure();
		ScrollEngine.rebase();
		ScrollEngine.tick();
	}
};
if (!customElements.get("sticky-header")) customElements.define("sticky-header", StickyHeader);
//#endregion
//#region src/components/sticky-content.js
/**
* Sticky element that follows the sticky header's offset.
*/
var StickyContent = class extends HTMLElement {
	#baseTop = null;
	#initialized = false;
	#ownsTop = false;
	#authorTop = null;
	handlers = {};
	static get observedAttributes() {
		return ["top", "disabled"];
	}
	connectedCallback() {
		if (document.readyState === "loading") {
			if (this.handlers.ready) return;
			this.handlers.ready = () => {
				this.handlers.ready = null;
				this.#init();
			};
			document.addEventListener("DOMContentLoaded", this.handlers.ready, { once: true });
			return;
		}
		this.#init();
	}
	disconnectedCallback() {
		const _ = this;
		if (_.handlers.ready) {
			document.removeEventListener("DOMContentLoaded", _.handlers.ready);
			_.handlers.ready = null;
		}
		if (!_.#initialized) return;
		_.#initialized = false;
		ScrollEngine.unregisterRider(_);
		_.#baseTop = null;
		_.removeAttribute("stuck");
		_.#releaseTop();
	}
	attributeChangedCallback(name, previousValue, currentValue) {
		if (!this.#initialized || previousValue === currentValue) return;
		if (name === "top") this.#applyTop();
		this.#baseTop = null;
		ScrollEngine.tick();
	}
	#init() {
		const _ = this;
		if (_.#initialized) return;
		_.#initialized = true;
		_.#applyTop();
		ScrollEngine.registerRider(_);
	}
	#applyTop() {
		const _ = this;
		const value = _.getAttribute("top");
		if (value === null || value === "") {
			_.#releaseTop();
			return;
		}
		if (!_.#ownsTop) {
			_.#authorTop = _.style.getPropertyValue("--sticky-content-top");
			_.#ownsTop = true;
		}
		_.style.setProperty("--sticky-content-top", value);
	}
	/** Gives the inline declaration back, if it was ours to give. */
	#releaseTop() {
		const _ = this;
		if (!_.#ownsTop) return;
		_.#ownsTop = false;
		const author = _.#authorTop;
		_.#authorTop = null;
		if (author) _.style.setProperty("--sticky-content-top", author);
		else _.style.removeProperty("--sticky-content-top");
	}
	/**
	* The resting sticky inset in px, with the header offset taken back out.
	* `getComputedStyle().top` resolves the whole calc — including whatever
	* `--header-group-offset` currently says — so that same value is subtracted
	* to recover the base.
	*
	* It subtracts `lastWritten`, NOT the live `ScrollEngine.offset`: the two
	* diverge whenever the offset has been recomputed but its var write hasn't
	* landed yet (a re-measure re-clamps outside the frame, for instance), and
	* subtracting the newer number from a computed value built on the older one
	* bakes that difference into the cache permanently.
	*
	* Cached — this is the component's only getComputedStyle read, and it
	* re-resolves only when geometry actually changed.
	* @returns {number} Base inset in px
	*/
	_baseTop() {
		if (this.#baseTop !== null) return this.#baseTop;
		const resolved = parseFloat(getComputedStyle(this).top);
		const applied = ScrollEngine.header && ScrollEngine.lastWritten !== null ? ScrollEngine.lastWritten : 0;
		this.#baseTop = Number.isFinite(resolved) ? resolved - applied : 0;
		return this.#baseTop;
	}
	_invalidateTop() {
		this.#baseTop = null;
	}
	/** Whether the rider is pinned at its effective sticky top. */
	get stuck() {
		return this.hasAttribute("stuck");
	}
	/** The resting sticky inset in px, excluding the header offset. */
	get top() {
		return this._baseTop();
	}
};
if (!customElements.get("sticky-content")) customElements.define("sticky-content", StickyContent);
//#endregion
export { SETTLE_LINEAR_CURVE, ScrollHandler, StickyContent, StickyHeader, makeSettleEase };

//# sourceMappingURL=sticky-header.esm.js.map