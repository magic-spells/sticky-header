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
var SHOW_DURATION_SCALE = .85;
var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
function clamp(value, min, max) {
	return Math.max(min, Math.min(max, value));
}
var ScrollEngine = {
	header: null,
	riders: /* @__PURE__ */ new Set(),
	offset: 0,
	motion: "idle",
	lastScrollY: 0,
	maxScrollY: 0,
	lastWritten: null,
	resizeUntil: 0,
	reducedAnchor: 0,
	revealAnchor: 0,
	rebaseOnNextScroll: false,
	stopsDirty: false,
	settle: null,
	rafId: null,
	idleTimer: null,
	listening: false,
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
		this.lastWritten = null;
		this.settle = null;
		this.motion = "idle";
		this.revealAnchor = 0;
		this.start();
		this.rebase();
		this.rebaseOnNextScroll = true;
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
		this.settle = null;
		this.motion = "idle";
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
	start() {
		if (this.listening) return;
		const _ = this;
		_.handlers.scroll = _.handlers.scroll || _.onScroll.bind(_);
		_.handlers.scrollEnd = _.handlers.scrollEnd || _.onScrollIdle.bind(_);
		_.handlers.resize = _.handlers.resize || _.onResize.bind(_);
		_.handlers.frame = _.handlers.frame || _.onFrame.bind(_);
		_.handlers.restore = _.handlers.restore || _.onRestore.bind(_);
		_.handlers.motionPreference = _.handlers.motionPreference || _.onMotionPreference.bind(_);
		window.addEventListener("scroll", _.handlers.scroll, { passive: true });
		window.addEventListener("scrollend", _.handlers.scrollEnd, { passive: true });
		window.addEventListener("resize", _.handlers.resize, { passive: true });
		window.visualViewport?.addEventListener("resize", _.handlers.resize, { passive: true });
		window.addEventListener("load", _.handlers.restore, { passive: true });
		window.addEventListener("pageshow", _.handlers.restore, { passive: true });
		reducedMotion.addEventListener("change", _.handlers.motionPreference);
		_.listening = true;
		_.refreshMaxScroll();
		_.lastScrollY = clamp(window.scrollY, 0, _.maxScrollY);
		_.reducedAnchor = _.lastScrollY;
	},
	stop() {
		const _ = this;
		window.removeEventListener("scroll", _.handlers.scroll);
		window.removeEventListener("scrollend", _.handlers.scrollEnd);
		window.removeEventListener("resize", _.handlers.resize);
		window.visualViewport?.removeEventListener("resize", _.handlers.resize);
		window.removeEventListener("load", _.handlers.restore);
		window.removeEventListener("pageshow", _.handlers.restore);
		reducedMotion.removeEventListener("change", _.handlers.motionPreference);
		clearTimeout(_.idleTimer);
		if (_.rafId) cancelAnimationFrame(_.rafId);
		_.rafId = null;
		_.idleTimer = null;
		_.listening = false;
		_.motion = "idle";
	},
	/** Wakes the rAF loop without a scroll — used by observers and the API. */
	tick() {
		if (!this.listening) return;
		this.handlers.frame = this.handlers.frame || this.onFrame.bind(this);
		if (!this.rafId) this.rafId = requestAnimationFrame(this.handlers.frame);
	},
	/** Re-anchors scroll tracking to the current position, producing no delta. */
	rebase() {
		this.refreshMaxScroll();
		this.lastScrollY = clamp(window.scrollY, 0, this.maxScrollY);
		this.reducedAnchor = this.lastScrollY;
		this.revealAnchor = this.lastScrollY + this.offset;
	},
	refreshMaxScroll() {
		this.maxScrollY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
	},
	/** Opens a quiet window where scroll deltas are ignored (URL-bar storms). */
	quiet() {
		this.resizeUntil = performance.now() + 100;
	},
	armIdle() {
		clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(this.handlers.scrollEnd, 120);
	},
	onScroll() {
		if (this.rebaseOnNextScroll) {
			this.rebaseOnNextScroll = false;
			this.rebase();
		}
		if (this.motion !== "settling") this.motion = "tracking";
		this.armIdle();
		this.tick();
	},
	/** Scroll restoration / bfcache return: adopt the position, stay visible. */
	onRestore() {
		this.rebaseOnNextScroll = false;
		this.rebase();
		if (this._glideMode()) {
			this.settle = null;
			this.motion = "idle";
			this.revealAnchor = 0;
		} else this.requestSettle(0, {
			reason: "show",
			forced: true
		});
		this.tick();
	},
	onMotionPreference() {
		this.settle = null;
		this.motion = "idle";
		this.rebase();
		this.tick();
	},
	onResize() {
		this.quiet();
		this.rebase();
		this.header?._measure();
		for (const rider of this.riders) rider._invalidateTop();
		this.tick();
	},
	/**
	* True scroll rest. Fires from native `scrollend` and from the 120ms
	* fallback timer; both land here and the work is idempotent, so iOS
	* momentum (which keeps firing `scroll`) can never settle mid-flick.
	*/
	onScrollIdle() {
		clearTimeout(this.idleTimer);
		if (this.motion === "settling") return;
		this.motion = "idle";
		const header = this.header;
		if (!header) {
			this.tick();
			return;
		}
		const { groupHeight } = header._geometry;
		if (groupHeight <= 0 || !this._trackable()) {
			this.tick();
			return;
		}
		const target = this._settleTarget();
		this.requestSettle(target, { reason: target < this.offset ? "hide" : "show" });
		this.tick();
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
		return Math.max(target, -this.lastScrollY);
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
		const settle = this.settle;
		if (settle && settle.to === to) {
			if (forced) settle.forced = true;
			return;
		}
		if (!settle && Math.abs(this.offset - to) <= .05) {
			this.offset = to;
			return;
		}
		const header = this.header;
		const config = header ? header._config : null;
		if (reducedMotion.matches) {
			this.settle = null;
			this.offset = to;
			this.motion = "idle";
			this.reducedAnchor = this.lastScrollY;
			return;
		}
		const base = config ? config.settleDuration : 900;
		const duration = Math.max(1, reason === "show" ? base * SHOW_DURATION_SCALE : base);
		this.settle = {
			from: this.offset,
			to,
			reason,
			forced,
			duration,
			start: null,
			ease: makeSettleEase(config ? config.settleOvershoot : .05)
		};
		this.motion = "settling";
		this.queueEvent("settle", {
			target: reason,
			from: this.settle.from,
			duration
		});
		this.tick();
	},
	cancelSettle() {
		if (!this.settle) return;
		this.settle = null;
		this.motion = "tracking";
		this.armIdle();
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
	* UNtranslated top — `rect.top` already carries the transform, so the offset
	* has to be taken back out of it or the check oscillates.
	* @returns {boolean} True while the group is pinned
	*/
	_pinned() {
		const header = this.header;
		if (!header) return false;
		return header.getBoundingClientRect().top - this.offset <= header._geometry.stickyTop + .5;
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
		return this.lastScrollY > header._config.revealThreshold;
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
			this.armIdle();
		}
	},
	onFrame(now) {
		const _ = this;
		_.rafId = null;
		let y = window.scrollY;
		if (y > _.maxScrollY) _.refreshMaxScroll();
		y = clamp(y, 0, _.maxScrollY);
		let delta = y - _.lastScrollY;
		_.lastScrollY = y;
		if (now < _.resizeUntil) delta = 0;
		if (delta !== 0) _.armIdle();
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
			if (reducedMotion.matches) {
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
		}
		header?._writeReveal();
		_._writeOffset();
		_._syncState(y);
		_._writeRiders(riderReads);
		_.flushEvents();
		if (_.motion === "settling" || _.motion === "tracking" && delta !== 0) _.tick();
	},
	_writeOffset() {
		if (!this.header) return;
		const offset = this.offset;
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
		const offset = this.header ? this.offset : 0;
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
	settleOvershoot: .05
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
			settleOvershoot: parseNumber(_.getAttribute("settle-overshoot"), DEFAULTS.settleOvershoot, 0, .2)
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
	* @returns {number} Distance from the group top to the reveal boundary, in px
	*/
	#measureRevealHeight(groupHeight) {
		const _ = this;
		const targets = _.querySelectorAll(`[${REVEAL_ATTRIBUTE}]`);
		if (!targets.length) return 0;
		const isDesktop = _.#mediaQuery ? _.#mediaQuery.matches : true;
		const hostTop = _.getBoundingClientRect().top;
		let boundary = null;
		for (const element of targets) {
			if (!_.#revealApplies(element.getAttribute(REVEAL_ATTRIBUTE), isDesktop)) continue;
			const rect = element.getBoundingClientRect();
			if (!rect.width && !rect.height) continue;
			const top = rect.top - hostTop;
			if (boundary === null || top < boundary) boundary = top;
		}
		if (boundary === null) return groupHeight;
		return clamp(Math.round(boundary), 0, groupHeight);
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
	/** Settles the header fully visible. */
	show() {
		ScrollEngine.requestSettle(0, {
			reason: "show",
			forced: true
		});
		ScrollEngine.tick();
	}
	/** Settles the header fully hidden. A no-op while locked or inactive. */
	hide() {
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
		_.style.removeProperty("--sticky-content-top");
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
	/** The `top` attribute is sugar for setting `--sticky-content-top` inline. */
	#applyTop() {
		const value = this.getAttribute("top");
		if (value === null || value === "") this.style.removeProperty("--sticky-content-top");
		else this.style.setProperty("--sticky-content-top", value);
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
export { SETTLE_LINEAR_CURVE, StickyContent, StickyHeader, makeSettleEase };

//# sourceMappingURL=sticky-header.esm.js.map