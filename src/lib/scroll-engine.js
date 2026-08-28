/*
  Scroll engine for <sticky-header>.

  A module singleton — one scroll listener, one rAF loop, one offset value,
  shared by the single <sticky-header> and every <sticky-content> rider.

  The engine owns motion only. It never touches `transform` and never reads
  component attributes directly: it writes `--header-group-offset` on <body>
  and pulls configuration and geometry through the `_`-prefixed accessors the
  host element exposes. Everything visual is a pure CSS reader of that var.

  Motion has three phases:
    tracking  — the offset follows the scroll 1:1, no easing, no lag
    settling  — a rAF tween of the same value toward fully shown or hidden
    idle      — nothing moving; the loop stops

  Because the settle is a JS tween of the same variable the tracking writes,
  cancelling it mid-flight is exact: the offset is already where the tween
  left it, and tracking simply resumes from there.

  There are THREE resting stops, not two:
    0                 full stack — near the page top
    −topOnlyHeight    "revealed" — the mid-page scroll-up target, the offset of
                      the topmost active [data-sticky-reveal] element from the
                      group top. 0 when nothing is tagged, which collapses the
                      whole model back to the original two stops.
    −groupHeight      hidden

  And a second, non-tracking mode: where hide-on-scroll is INACTIVE but a
  reveal boundary exists, the offset is POSITION-based rather than
  direction-based, so the bars above the boundary behave exactly like page
  content — away going down, back at the same scroll position going up.
*/

import { makeSettleEase } from './easing.js';

const TOP_THRESHOLD = 8; // px from the very top still considered "top"
const IDLE_MS = 120; // fallback scroll-idle timeout where scrollend is missing
const RESIZE_QUIET_MS = 100; // window after a resize in which deltas are ignored
const BINARY_DELTA = 5; // reduced-motion: min delta before the offset flips
const WRITE_EPSILON = 0.05; // px the offset must move before it's written again
const SHOW_DURATION_SCALE = 0.85; // show settles slightly faster than hide

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// clamp helper: keeps a number within a range
function clamp(value, min, max) {
	return Math.max(min, Math.min(max, value));
}

const ScrollEngine = {
	header: null,
	riders: new Set(),

	offset: 0,
	motion: 'idle',

	lastScrollY: 0,
	maxScrollY: 0,
	lastWritten: null,
	resizeUntil: 0,
	reducedAnchor: 0,
	// scroll position the position-based glide measures from — the y at which
	// the group was last fully shown while pinned
	revealAnchor: 0,
	rebaseOnNextScroll: false,
	// the resting stops moved and the offset has to be re-evaluated against them
	stopsDirty: false,

	settle: null,
	rafId: null,
	idleTimer: null,
	listening: false,

	// events are queued during compute and dispatched in the write phase, so a
	// listener can never run between a read and the write that depends on it
	pendingEvents: [],

	// last published state, so attribute writes only happen on real transitions
	state: { scroll: null, hidden: null, revealed: null, tracking: null, locked: null },

	handlers: {},

	/**
	 * Registers the single <sticky-header>. A second host is rejected — the
	 * engine writes one global offset, so two would fight over it.
	 * @param {HTMLElement} header - The host element
	 * @returns {boolean} True when this host became the primary
	 */
	registerHeader(header) {
		if (this.header && this.header !== header) {
			console.warn('<sticky-header> only one instance can be active — the extra instance is inert');
			return false;
		}
		this.header = header;
		this.offset = 0;
		this.lastWritten = null;
		this.settle = null;
		this.motion = 'idle';
		this.revealAnchor = 0;
		this.start();
		this.rebase();
		// scroll restoration can land after this point; the first scroll that
		// arrives is a restore, not a gesture, so it must not become a delta.
		// Only while a restoration can still ARRIVE, though — load/pageshow are
		// what clear this flag, and they never fire again for a header mounted
		// after them (SPA, late upgrade). Such a host has already adopted the
		// current position from the rebase() above, so arming here would leave
		// the flag set forever and eat its first real gesture.
		this.rebaseOnNextScroll = document.readyState !== 'complete';
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
		this.motion = 'idle';
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

		window.addEventListener('scroll', _.handlers.scroll, { passive: true });
		window.addEventListener('scrollend', _.handlers.scrollEnd, { passive: true });
		window.addEventListener('resize', _.handlers.resize, { passive: true });
		window.visualViewport?.addEventListener('resize', _.handlers.resize, { passive: true });
		// browser scroll restoration lands after DOMContentLoaded
		window.addEventListener('load', _.handlers.restore, { passive: true });
		window.addEventListener('pageshow', _.handlers.restore, { passive: true });
		reducedMotion.addEventListener('change', _.handlers.motionPreference);

		_.listening = true;
		_.refreshMaxScroll();
		_.lastScrollY = clamp(window.scrollY, 0, _.maxScrollY);
		_.reducedAnchor = _.lastScrollY;
	},

	stop() {
		const _ = this;
		window.removeEventListener('scroll', _.handlers.scroll);
		window.removeEventListener('scrollend', _.handlers.scrollEnd);
		window.removeEventListener('resize', _.handlers.resize);
		window.visualViewport?.removeEventListener('resize', _.handlers.resize);
		window.removeEventListener('load', _.handlers.restore);
		window.removeEventListener('pageshow', _.handlers.restore);
		reducedMotion.removeEventListener('change', _.handlers.motionPreference);
		clearTimeout(_.idleTimer);
		if (_.rafId) cancelAnimationFrame(_.rafId);
		_.rafId = null;
		_.idleTimer = null;
		_.listening = false;
		_.motion = 'idle';
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
		// the glide anchor is rebased so the CURRENT offset is preserved — moving
		// it to y outright would snap the bars back into view on every resize
		this.revealAnchor = this.lastScrollY + this.offset;
	},

	refreshMaxScroll() {
		this.maxScrollY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
	},

	/** Opens a quiet window where scroll deltas are ignored (URL-bar storms). */
	quiet() {
		this.resizeUntil = performance.now() + RESIZE_QUIET_MS;
	},

	/*
	  Arms the idle fallback. This is driven by actual MOVEMENT, not just by
	  scroll events: a scroll event can land a frame before the delta it
	  describes, so the idle it arms can fire, start a settle, and then have
	  that settle cancelled by the trailing delta. Re-arming from the frame loop
	  on every non-zero delta means the last real movement always gets the final
	  word, and iOS momentum keeps pushing rest out until the decay truly ends.
	*/
	armIdle() {
		clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(this.handlers.scrollEnd, IDLE_MS);
	},

	onScroll() {
		if (this.rebaseOnNextScroll) {
			// a restored scroll position, not a gesture — adopt it with no delta
			this.rebaseOnNextScroll = false;
			this.rebase();
		}
		if (this.motion !== 'settling') this.motion = 'tracking';
		this.armIdle();
		this.tick();
	},

	/** Scroll restoration / bfcache return: adopt the position, stay visible. */
	onRestore() {
		this.rebaseOnNextScroll = false;
		this.rebase();
		if (this._glideMode()) {
			// a restore is not a gesture, and the glide is ABSOLUTE: a bar with no
			// reason to stay pinned belongs exactly where the page put it, so the
			// anchor is seeded at the page top rather than preserving the offset.
			// Landing mid-page must not leave it visible, nor move its return point.
			this.settle = null;
			this.motion = 'idle';
			this.revealAnchor = 0;
		} else {
			this.requestSettle(0, { reason: 'show', forced: true });
		}
		this.tick();
	},

	onMotionPreference() {
		this.settle = null;
		this.motion = 'idle';
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
		if (this.motion === 'settling') return;
		this.motion = 'idle';

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
		this.requestSettle(target, { reason: target < this.offset ? 'hide' : 'show' });
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
		if (travel <= 0) {
			target = -groupHeight;
		} else {
			const fraction = clamp((upper - this.offset) / travel, 0, 1);
			target = fraction > header._config.settleThreshold ? -groupHeight : upper;
		}

		// a target the safety clamp would never let the offset reach is not a
		// target: aiming at one starts a tween that can't move, and the settle
		// event that goes with it would then re-fire at every idle
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
		const header = this.header;
		const { groupHeight, topOnlyHeight } = header._geometry;
		if (groupHeight <= 0) return;

		if (glide) {
			// the glide is position-based, so there is nothing to tween: clamp into
			// the new range and re-anchor so the mapping continues from right here
			this.settle = null;
			this.motion = 'idle';
			this.offset = clamp(this.offset, -topOnlyHeight, 0);
			this.revealAnchor = y + this.offset;
		} else if (this.motion !== 'settling') {
			const target = trackable ? this._settleTarget() : 0;
			this.requestSettle(target, {
				reason: target < this.offset ? 'hide' : 'show',
				forced: true,
			});
		}
	},

	/**
	 * Starts a settle tween toward `to`, unless one with the same intent is
	 * already running or the offset is already there.
	 * @param {number} to - Target offset in px
	 * @param {object} options - `reason` ('show'|'hide') and `forced`
	 */
	requestSettle(to, { reason = to < 0 ? 'hide' : 'show', forced = false } = {}) {
		const settle = this.settle;
		if (settle && settle.to === to) {
			// same destination: upgrade in place rather than restarting the tween,
			// so a forced request mid-settle doesn't rewind what already played
			if (forced) settle.forced = true;
			return;
		}
		if (!settle && Math.abs(this.offset - to) <= WRITE_EPSILON) {
			this.offset = to;
			return;
		}

		const header = this.header;
		const config = header ? header._config : null;

		// reduced motion never tweens — the offset flips outright
		if (reducedMotion.matches) {
			this.settle = null;
			this.offset = to;
			this.motion = 'idle';
			this.reducedAnchor = this.lastScrollY;
			return;
		}

		const base = config ? config.settleDuration : 900;
		const duration = Math.max(1, reason === 'show' ? base * SHOW_DURATION_SCALE : base);

		this.settle = {
			from: this.offset,
			to,
			reason,
			forced,
			duration,
			// stamped by the first frame from the rAF clock — mixing
			// performance.now() here with the rAF timestamp there can yield t < 0
			start: null,
			ease: makeSettleEase(config ? config.settleOvershoot : 0.05),
		};
		this.motion = 'settling';

		this.queueEvent('settle', { target: reason, from: this.settle.from, duration });
		this.tick();
	},

	cancelSettle() {
		if (!this.settle) return;
		this.settle = null;
		this.motion = 'tracking';
		// tracking resumed, so rest has to be re-detected from here
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
		this.pendingEvents.push({ name, detail });
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
	 * has to be taken back out of it or the check oscillates on the show
	 * overshoot, where `offset > 0` drags the rect below `stickyTop`.
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
	 * This runs in the frame's read phase, so the read is free of layout thrash.
	 * @returns {boolean} True while the group is pinned
	 */
	_pinned() {
		const header = this.header;
		if (!header) return false;
		const rect = header.getBoundingClientRect();
		const applied = getComputedStyle(header).transform === 'none' ? 0 : this.offset;
		return rect.top - applied <= header._geometry.stickyTop + 0.5;
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
		if (header.hasAttribute('disabled')) return false;
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
		if (!(pinned === undefined ? this._pinned() : pinned)) return false;

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
		// wall-clock timing off the rAF clock, so a background-tab wakeup
		// clamps to the end instead of replaying the tween
		if (settle.start === null) settle.start = now;
		const t = clamp((now - settle.start) / settle.duration, 0, 1);
		this.offset = settle.from + (settle.to - settle.from) * settle.ease(t);
		if (t >= 1) {
			this.offset = settle.to;
			this.settle = null;
			this.motion = 'idle';
			// re-check the stop the tween actually landed on. A forced show that
			// outlived a short gesture can leave the group at 0 mid-page — an
			// illegal stop once anything is tagged — and the stops themselves may
			// have moved during the ~900ms it was running. The epsilon guard in
			// requestSettle makes this free whenever it landed correctly.
			this.armIdle();
		}
	},

	onFrame(now) {
		const _ = this;
		_.rafId = null;

		// ---- reads ----
		let y = window.scrollY;
		if (y > _.maxScrollY) _.refreshMaxScroll();
		y = clamp(y, 0, _.maxScrollY);

		let delta = y - _.lastScrollY;
		_.lastScrollY = y;
		if (now < _.resizeUntil) delta = 0;
		// real movement this frame — push scroll-rest detection out from here
		if (delta !== 0) _.armIdle();

		const header = _.header;
		// dirty-gated: re-resolves the reveal boundary only when something moved
		// it, and takes its rect reads here in the read phase with the others
		header?._readReveal();
		const glide = _._glideMode();
		const pinned = _._movable(glide) ? _._pinned() : false;
		const trackable = _._trackable(pinned);
		const riderReads = _._readRiders();

		// ---- compute ----
		if (header) {
			const { groupHeight, topOnlyHeight } = header._geometry;

			// the stops moved since the last frame — re-settle onto the right one
			// before this frame's motion, using the reads taken above
			if (_.stopsDirty) {
				_.stopsDirty = false;
				_._applyStops(y, glide, trackable);
			}

			if (reducedMotion.matches) {
				// binary: no tracking, no tween — flip past a 5px direction delta,
				// between whichever two stops currently apply
				if (glide) {
					// already direct; a position mapping needs no motion preference
					_.offset = _._glideOffset(y, pinned, topOnlyHeight);
				} else if (!trackable) {
					_.offset = 0;
					_.reducedAnchor = y;
				} else {
					const drift = y - _.reducedAnchor;
					if (Math.abs(drift) >= BINARY_DELTA) {
						_.offset = drift > 0 ? -groupHeight : -topOnlyHeight;
						_.reducedAnchor = y;
					}
				}
				_.motion = 'idle';
			} else if (glide) {
				// POSITION-based, not direction-based: the bars above the boundary
				// leave with the page and come back at the exact scroll position they
				// left, while the header itself stays pinned. No settle, no tween.
				if (_.settle) {
					_._stepSettle(now);
					// keep the mapping continuous under a forced tween, so position
					// tracking resumes from exactly where the tween lands
					_.revealAnchor = y + _.offset;
				} else {
					_.offset = _._glideOffset(y, pinned, topOnlyHeight);
					if (delta !== 0) _.motion = 'tracking';
				}
			} else {
				if (!trackable) {
					_.requestSettle(0, { reason: 'show', forced: true });
				} else if (_.settle && !_.settle.forced && Math.abs(delta) >= 1) {
					// the user re-engaged mid-settle: resume tracking from exactly here
					_.cancelSettle();
				}

				if (_.settle) {
					_._stepSettle(now);
				} else if (trackable && delta !== 0) {
					// the 1:1 core — scroll down hides, scroll up shows, no easing.
					// Gated on a real delta: a zero-delta tick (a resize, an observer,
					// an attribute change) must never enter or perpetuate tracking, or
					// the loop spins for the life of the page and data-header-tracking
					// never clears.
					//
					// The ceiling is the reveal stop, but only once the group has
					// actually travelled past it: `max(-topOnlyHeight, offset)` never
					// pushes the group DOWN, so crossing the reveal threshold with the
					// stack fully shown glides on from 0 instead of snapping to it.
					const ceiling = Math.min(0, Math.max(-topOnlyHeight, _.offset));
					_.offset = clamp(_.offset - delta, -groupHeight, ceiling);
					_.motion = 'tracking';
				}
			}

			// never hide more pixels than have been scrolled, in any mode: a group
			// taller than the current scroll position would otherwise translate out
			// of a flow slot that is still on screen and open a gap above the page
			if (_.offset < -y) _.offset = -y;

			// Outside the glide the anchor is kept coherent with wherever the offset
			// actually is, so ENTERING the glide is always continuous. A lock is the
			// case that bites: it suspends the glide and force-shows, and a stale
			// anchor would then jump the group by the whole boundary on the first
			// unlocked frame. Inside the glide the anchor is the mapping's own
			// state, owned by _glideOffset() and the tween sync.
			if (!glide) _.revealAnchor = y + _.offset;
		}

		// ---- writes ----
		header?._writeReveal();
		_._writeOffset();
		_._syncState(y);
		_._writeRiders(riderReads);
		_.flushEvents();

		// keep the loop alive only while something is actually moving; a
		// zero-delta frame lets it sleep, and the armed idle timer (or the next
		// scroll event) is what wakes it to finish the job
		if (_.motion === 'settling' || (_.motion === 'tracking' && delta !== 0)) _.tick();
	},

	_writeOffset() {
		if (!this.header) return;
		const offset = this.offset;
		const settled = this.motion === 'idle';
		// the final easing steps fall under the write epsilon, so a settle that
		// just finished force-publishes once or the resting value stays short
		if (
			this.lastWritten !== null &&
			!settled &&
			Math.abs(offset - this.lastWritten) <= WRITE_EPSILON
		) {
			return;
		}
		if (this.lastWritten === offset) return;
		this.lastWritten = offset;
		document.body.style.setProperty('--header-group-offset', `${offset}px`);
	},

	_syncState(y) {
		const header = this.header;
		if (!header) return;

		const body = document.body;
		const state = this.state;
		const { groupHeight, topOnlyHeight } = header._geometry;

		const scrollState = y <= TOP_THRESHOLD ? 'top' : 'scrolling';
		if (scrollState !== state.scroll) {
			state.scroll = scrollState;
			body.setAttribute('data-state', scrollState);
		}

		const locked = header._isLocked();
		if (locked !== state.locked) {
			state.locked = locked;
			body.toggleAttribute('data-header-locked', locked);
		}

		const tracking = this.motion !== 'idle';
		if (tracking !== state.tracking) {
			state.tracking = tracking;
			body.toggleAttribute('data-header-tracking', tracking);
			header.toggleAttribute('data-tracking', tracking);
		}

		// "hidden" is a SETTLED fact, so it is only ever evaluated at rest. Frozen
		// mid-motion, which keeps a flick that momentarily clamps to −groupHeight
		// from announcing a hide, and makes the hide/show events fire on
		// completion rather than the instant a settle starts moving.
		if (this.motion === 'idle') {
			const hidden = groupHeight > 0 && this.offset <= -groupHeight + WRITE_EPSILON;
			if (hidden !== state.hidden) {
				const first = state.hidden === null;
				state.hidden = hidden;
				body.toggleAttribute('data-header-hidden', hidden);
				header.toggleAttribute('data-hidden', hidden);
				if (!first) header._emit(hidden ? 'hide' : 'show', {});
			}

			// resting at the reveal stop, which only exists as a distinct state
			// while the boundary is strictly inside the group
			const revealable = topOnlyHeight > 0 && topOnlyHeight < groupHeight;
			const revealed = revealable && Math.abs(this.offset + topOnlyHeight) <= WRITE_EPSILON;
			if (revealed !== state.revealed) {
				const first = state.revealed === null;
				state.revealed = revealed;
				body.toggleAttribute('data-header-revealed', revealed);
				if (revealed && !first) header._emit('reveal', {});
			}
		}
	},

	/*
	  Rider handling — the ONE place rider state is computed.

	  <sticky-content> positions itself with a MOVING sticky inset:
	      top: calc(base + var(--header-group-offset))
	  which is continuous at every scroll position by construction. The browser
	  pins the rider at max(flowTop, base + offset) with no help from JS, so the
	  engine never writes a position — it only publishes the `[stuck]` styling
	  hook. (Riding the header by a transform gated on that hook is exactly what
	  this avoids: a rider that pins while the header is already hidden would
	  jump by the whole offset.)

	  Reads and writes are two passes so a `[stuck]` toggle can't invalidate the
	  rect read of the rider after it.
	*/
	_readRiders() {
		if (!this.riders.size) return null;
		// the RAW offset, overshoot included — this has to match what CSS is
		// actually resolving the inset against, or `[stuck]` flickers on bounce
		const offset = this.header ? this.offset : 0;
		const reads = [];
		for (const rider of this.riders) {
			if (rider.hasAttribute('disabled')) {
				reads.push({ rider, stuck: false });
				continue;
			}
			const effectiveTop = rider._baseTop() + offset;
			reads.push({ rider, stuck: rider.getBoundingClientRect().top <= effectiveTop + 0.5 });
		}
		return reads;
	},

	_writeRiders(reads) {
		if (!reads) return;
		for (const { rider, stuck } of reads) {
			if (stuck !== rider.hasAttribute('stuck')) rider.toggleAttribute('stuck', stuck);
		}
	},

	_clearBody() {
		const body = document.body;
		body.style.removeProperty('--header-group-offset');
		body.style.removeProperty('--header-group-height');
		body.style.removeProperty('--header-height');
		body.style.removeProperty('--announcement-bar-height');
		body.style.removeProperty('--header-reveal-offset');
		body.removeAttribute('data-state');
		body.removeAttribute('data-header-hidden');
		body.removeAttribute('data-header-revealed');
		body.removeAttribute('data-header-tracking');
		body.removeAttribute('data-header-locked');
		this.state = { scroll: null, hidden: null, revealed: null, tracking: null, locked: null };
		this.lastWritten = null;
	},
};

export {
	ScrollEngine,
	TOP_THRESHOLD,
	IDLE_MS,
	RESIZE_QUIET_MS,
	BINARY_DELTA,
	WRITE_EPSILON,
	reducedMotion,
	clamp,
};
