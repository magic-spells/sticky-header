/*
  Scroll engine for <sticky-header>.

  A module singleton — one offset value, shared by the single <sticky-header>
  and every <sticky-content> rider.

  The scroll SIGNAL is not this file's job. Window listeners, the rAF loop,
  position clamping, quiet windows, velocity, movement-armed rest detection and
  scroll-restoration adoption all live in ScrollHandler, which the engine
  subscribes to once. What arrives here is a per-frame packet of numbers that
  are already correct on mobile. Everything below is what the engine adds on
  top of that signal: the three resting stops, the settle tween, the motion
  state machine, and the one published offset.

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

  Finally, `tracking-smoothing` is a PUBLICATION-boundary effect and nothing
  else. The state machine, the thresholds, the stops and the anchors all run on
  the raw 1:1 offset; only the number handed to CSS is eased toward it. Which
  means anything that takes an applied transform back out of a measured rect
  has to read what CSS actually resolved (`appliedOffset`) rather than the raw
  value — see _pinned() and _readRiders().
*/

import { makeSettleEase } from './easing.js';
import { ScrollHandler, expApproach, clamp } from './scroll-handler.js';

const TOP_THRESHOLD = 8; // px from the very top still considered "top"
const BINARY_DELTA = 5; // reduced-motion: min delta before the offset flips
const WRITE_EPSILON = 0.05; // px the offset must move before it's written again
const SHOW_DURATION_SCALE = 0.85; // show settles slightly faster than hide

/*
  The engine keeps its own reduced-motion query for ONE reason: a preference
  flip has to cancel an in-flight tween and re-anchor, which is a reaction to a
  motion preference rather than to a scroll. The per-frame READ is gone — the
  packet carries `reducedMotion`, resolved once per frame by the handler.
*/
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const ScrollEngine = {
	header: null,
	riders: new Set(),

	// the RAW offset: 1:1 with the scroll, and what every decision below is made
	// against. `published` is what CSS is given — the same number unless
	// tracking-smoothing is on.
	offset: 0,
	published: 0,
	motion: 'idle',

	// mirror of the handler's clamped position. The handler owns the delta base;
	// this exists for _settleTarget()'s safety floor and _trackable()'s reveal
	// threshold, and it keeps updating every frame while locked, so unlocking
	// never releases a phantom delta.
	y: 0,
	lastWritten: null,
	reducedAnchor: 0,
	// scroll position the position-based glide measures from — the y at which
	// the group was last fully shown while pinned
	revealAnchor: 0,
	// the resting stops moved and the offset has to be re-evaluated against them
	stopsDirty: false,
	// a settle landed and the stop it landed on has to be re-checked
	restDue: false,

	settle: null,
	/** @type {object | null} The ScrollHandler subscription. */
	sub: null,

	// events are queued during compute and dispatched in the write phase, so a
	// listener can never run between a read and the write that depends on it
	pendingEvents: [],

	// last published state, so attribute writes only happen on real transitions
	state: { scroll: null, hidden: null, revealed: null, tracking: null, locked: null },

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
			console.warn('<sticky-header> only one instance can be active — the extra instance is inert');
			return false;
		}
		this.header = header;
		this.offset = 0;
		this.published = 0;
		this.lastWritten = null;
		this.settle = null;
		this.motion = 'idle';
		this.revealAnchor = 0;
		this.restDue = false;
		this.start();
		// adopt the current position with no delta. Scroll restoration can still
		// land after this point, and adopting THAT is the handler's job: it arms
		// its own restore flag while the document is loading and clears it on
		// load/pageshow, so a header mounted after those (SPA, late upgrade) is
		// left with the position it just adopted rather than eating its first
		// real gesture.
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
		this.motion = 'idle';
		// nothing left to re-check, and leaving it set would hold the loop awake
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

		reducedMotion.addEventListener('change', _.handlers.motionPreference);

		_.sub = ScrollHandler.subscribe({
			frame: _.handlers.frame,
			rest: _.handlers.rest,
			rebase: _.handlers.rebase,
			resize: _.handlers.resize,
		});

		// subscribing is what starts the handler, so the position is only readable
		// afterwards. It schedules a frame rather than running one, so nothing has
		// called back yet.
		_.y = ScrollHandler.y;
		_.reducedAnchor = _.y;
	},

	stop() {
		const _ = this;
		reducedMotion.removeEventListener('change', _.handlers.motionPreference);
		// the last unsubscription is what detaches the handler's own listeners
		_.sub?.unsubscribe();
		_.sub = null;
		_.motion = 'idle';
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
		// the glide anchor is rebased so the CURRENT offset is preserved — moving
		// it to y outright would snap the bars back into view on every resize
		_.revealAnchor = _.y + _.offset;

		if (reason !== 'restore') return;

		if (_._glideMode()) {
			// a restore is not a gesture, and the glide is ABSOLUTE: a bar with no
			// reason to stay pinned belongs exactly where the page put it, so the
			// anchor is seeded at the page top rather than preserving the offset.
			// Landing mid-page must not leave it visible, nor move its return point.
			_.settle = null;
			_.motion = 'idle';
			_.revealAnchor = 0;
		} else {
			_.requestSettle(0, { reason: 'show', forced: true });
		}
	},

	/*
	  Viewport change. This is the `resize` callback rather than `rebase('resize')`
	  on purpose: the handler only rebases a resize when it quiets one, and a
	  height-only change (mobile URL bar, soft keyboard) never quiets, so it
	  reports no rebase at all. Geometry still has to be re-measured for it — the
	  engine's half of a resize is not the anchor, it is the fact that every
	  cached height and rider inset may now be stale.
	*/
	onResize() {
		this.header?._measure();
		for (const rider of this.riders) rider._invalidateTop();
	},

	onMotionPreference() {
		this.settle = null;
		this.motion = 'idle';
		// re-anchors and ticks; the handler zeroes its own velocity separately
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
		if (_.motion === 'settling') return;
		_.motion = 'idle';
		// rest IS the re-check, so a pending one is subsumed rather than repeated
		_.restDue = false;
		// off-frame, so the pinned test has to take its own rect read here
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
		this.requestSettle(target, { reason: target < this.offset ? 'hide' : 'show' });
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
		const _ = this;

		/*
		  Hand off from the PUBLISHED position first. Under tracking-smoothing the
		  group is visually at `published` while the raw offset has already run
		  ahead of it, and a tween starting from the raw value would snap the group
		  by the whole lag on its first frame. Adopting it is also what reconverges
		  the two numbers: from here on the tween drives both, and every test below
		  (the epsilon guard included) is asking about the position the user can
		  actually see. With smoothing off the two are equal and this is a no-op.
		*/
		if (_.published !== _.offset) _.offset = _.published;

		const settle = _.settle;
		if (settle && settle.to === to) {
			// same destination: upgrade in place rather than restarting the tween,
			// so a forced request mid-settle doesn't rewind what already played
			if (forced) settle.forced = true;
			return;
		}
		if (!settle && Math.abs(_.offset - to) <= WRITE_EPSILON) {
			_.offset = to;
			return;
		}

		const header = _.header;
		const config = header ? header._config : null;

		// reduced motion never tweens — the offset flips outright
		if (reducedMotion.matches) {
			_.settle = null;
			_.offset = to;
			_.motion = 'idle';
			_.reducedAnchor = _.y;
			return;
		}

		const base = config ? config.settleDuration : 900;
		const duration = Math.max(1, reason === 'show' ? base * SHOW_DURATION_SCALE : base);

		_.settle = {
			from: _.offset,
			to,
			reason,
			forced,
			duration,
			// stamped by the first frame from the rAF clock — mixing
			// performance.now() here with the rAF timestamp there can yield t < 0
			start: null,
			ease: makeSettleEase(config ? config.settleOvershoot : 0.05),
		};
		_.motion = 'settling';

		_.queueEvent('settle', { target: reason, from: _.settle.from, duration });
		_.tick();
	},

	cancelSettle() {
		if (!this.settle) return;
		this.settle = null;
		this.motion = 'tracking';
		/*
		  No idle re-arm here, and none is needed. Rest is armed from MOVEMENT, and
		  the only thing that cancels a settle is a frame carrying |delta| >= 1 —
		  a frame on which ScrollHandler.onFrame already called _armIdle(), in its
		  read phase, before dispatching to any subscriber. So by the time this
		  runs a rest is always owed, which is exactly the guarantee the engine's
		  own armIdle() used to provide: the last real movement gets the final
		  word, and the header can never be stranded mid-travel with no timer left
		  to finish the job.
		*/
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
		// the published value is its own number under tracking-smoothing, and it is
		// the one CSS is holding — leaving it outside the new range would keep the
		// group parked off-screen while the raw offset eased away from it
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
		const applied = getComputedStyle(header).transform === 'none' ? 0 : this.appliedOffset;
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
		// wall-clock timing off the rAF clock, so a background-tab wakeup
		// clamps to the end instead of replaying the tween
		if (settle.start === null) settle.start = now;
		const t = clamp((now - settle.start) / settle.duration, 0, 1);
		this.offset = settle.from + (settle.to - settle.from) * settle.ease(t);
		if (t >= 1) {
			this.offset = settle.to;
			this.settle = null;
			this.motion = 'idle';
			/*
			  Re-check the stop the tween actually landed on. A forced show that
			  outlived a short gesture can leave the group at 0 mid-page — an illegal
			  stop once anything is tagged — and the stops themselves may have moved
			  during the ~900ms it was running.

			  This used to arm the idle timer to get the re-check. Rest is armed from
			  MOVEMENT now, and a tween completing is not movement, so there may be no
			  rest owed at all: the question is carried as a flag and answered by the
			  next frame that is not moving, with the keep-alive in onFrame holding
			  the loop open for it. That also lands it in the compute phase, where
			  this frame's `trackable` has already been read — the old path took a
			  rect read off-frame to answer the same question.
			*/
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

		// ---- reads ----
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

			// a settle landed and its resting place is owed a re-check. Deferred to a
			// frame with no movement in it: injecting a settle into a live gesture
			// would cost a frame of 1:1 tracking to a tween that the very next delta
			// cancels anyway.
			if (_.restDue && delta === 0 && _.motion !== 'settling') {
				_.restDue = false;
				_._settleToStop(trackable);
			}

			if (reduced) {
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
					// Gated on a real delta: a zero-delta frame (a resize, an observer,
					// an attribute change, the handler's own velocity tail) must never
					// enter or perpetuate tracking, or the loop spins for the life of
					// the page and data-header-tracking never clears.
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

			/*
			  The publication boundary, and the ONLY place smoothing exists.

			  Everything above ran on the raw offset. `tracking-smoothing` eases the
			  number CSS is given toward it with a time constant, so a scroll that
			  arrives in coarse steps is published as a continuous move. It applies
			  only while tracking — both the direction-based mode and the glide:
			  a settle is a tween that is already smooth and must not be smoothed
			  twice, and at idle the published value snaps to the raw one so every
			  resting stop is landed on exactly. tau 0 (the default) resolves to the
			  raw value outright, which is the whole opt-out.
			*/
			const tau = _.motion === 'tracking' ? header._config.trackingSmoothing : 0;
			_.published = expApproach(_.published, _.offset, dt, tau);
		}

		// ---- writes ----
		header?._writeReveal();
		_._writeOffset();
		_._syncState(y);
		_._writeRiders(riderReads);
		_.flushEvents();

		/*
		  Keep the loop alive only while something is actually moving; a zero-delta
		  frame with nothing pending lets it sleep, and the handler's own
		  movement-armed rest (or the next scroll event) is what wakes it to finish
		  the job. The last clause is smoothing's: the published value can still be
		  converging after the raw one has stopped, and it has to reach the raw
		  value before the loop is allowed to sleep or it parks a fraction short.
		*/
		return (
			_.motion === 'settling' ||
			(_.motion === 'tracking' && delta !== 0) ||
			_.restDue ||
			Math.abs(_.published - _.offset) > WRITE_EPSILON
		);
	},

	_writeOffset() {
		if (!this.header) return;
		// the PUBLISHED value, which is the raw offset unless smoothing is on
		const offset = this.published;
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
		// the APPLIED offset, overshoot included — this has to match what CSS is
		// actually resolving the inset against, or `[stuck]` flickers on bounce.
		// Under tracking-smoothing that is the published value, not the raw one.
		const offset = this.header ? this.appliedOffset : 0;
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

export { ScrollEngine, TOP_THRESHOLD, BINARY_DELTA, WRITE_EPSILON, reducedMotion, clamp };
// IDLE_MS and RESIZE_QUIET_MS moved to the scroll handler along with the timing
// they describe. Re-exported so this module's surface is unchanged.
export { IDLE_MS, RESIZE_QUIET_MS } from './scroll-handler.js';
