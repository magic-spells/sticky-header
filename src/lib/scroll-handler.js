/*
  Scroll handler — the shared scroll SIGNAL for the magic-spells ecosystem.

  A module singleton: one set of window listeners, one self-terminating rAF
  loop, one normalized scroll position, shared by every consumer on the page.

  It owns no visuals. It writes no CSS variables, touches no elements, emits no
  DOM events and has zero runtime dependencies. Consumers subscribe with plain
  callbacks and get a per-frame packet:

      const sub = ScrollHandler.subscribe({
        frame({ y, rawY, delta, velocity, dt, now, quiet, reducedMotion }) {},
        rest() {},
        rebase(reason) {},
        resize(metrics) {},
      });

  A `frame` callback returning `true` keeps the loop awake for another frame
  (an in-flight ease, a settle tween); returning anything else lets the loop
  sleep as soon as nothing else needs it. That is the whole cooperative
  contract — the handler never assumes a consumer wants frames it did not ask
  for, and a page whose consumers are all at rest costs zero frames.

  Everything here is time-constant based rather than per-frame based, so the
  same wall-clock span produces the same result at 60Hz, 120Hz, or through a
  dropped-frame pattern. The reference constants were tuned at 60Hz and are
  converted (not replaced) below, so the feel at 60Hz is unchanged.

  Nothing touches `window` or `document` at import time: the module has to be
  importable in Node, and reading globals at call time is also what lets the
  test suite stub them.
*/

import { ViewportMetrics } from './viewport-metrics.js';

/*
  ---- constants ----

  MAX_FRAME_DELTA caps the frame delta so a woken loop (background tab, a long
  main-thread block, a dropped-frame run) cannot take one huge easing step.
  FIRST_FRAME_DELTA is what a freshly woken loop reports before it has a
  previous timestamp to subtract.
*/
const MAX_FRAME_DELTA = 64; // ms ceiling on a single frame delta
const FIRST_FRAME_DELTA = 16; // ms assumed for the first frame after a wake

const IDLE_MS = 120; // fallback scroll-rest timeout where `scrollend` is missing
const RESIZE_QUIET_MS = 100; // window after a resize in which deltas are ignored

const MAX_VELOCITY = 100; // px clamp either side of zero
const VELOCITY_THRESHOLD = 0.01; // below this, velocity snaps to exactly 0

/*
  The velocity model came from scroll-progress, where it was expressed per
  FRAME: an EMA of `0.15` per scroll event, and a `* 0.76` decay per rAF frame.
  Both are frame-rate dependent — at 120Hz the decay runs twice as often, so
  velocity dies twice as fast per unit of wall-clock time and the same flick
  feels different on a 120Hz phone than on a 60Hz one.

  Converting to a time constant fixes that without changing the 60Hz feel. A
  per-frame factor `f` applied every `FRAME_MS` is exactly `exp(-FRAME_MS / τ)`
  when `τ = -FRAME_MS / ln(f)`:

      decay 0.76 per 16.667ms  →  τ = -16.667 / ln(0.76)     ≈ 60.73ms
      EMA   0.15 per 16.667ms  →  τ = -16.667 / ln(1 - 0.15) ≈ 102.55ms

  They are derived here rather than hardcoded, so the identity with the
  original numbers is exact rather than rounded to two decimals.
*/
const REFERENCE_FRAME_MS = 1000 / 60;
const VELOCITY_DECAY_TAU = -REFERENCE_FRAME_MS / Math.log(0.76);
const EMA_TAU = -REFERENCE_FRAME_MS / Math.log(1 - 0.15);

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
	if (typeof fn !== 'function') return undefined;
	try {
		return fn(arg);
	} catch (error) {
		console.error(error);
		return undefined;
	}
}

const ScrollHandler = {
	/*
	  Height-only viewport resizes (mobile URL-bar collapse/expand, a soft
	  keyboard) open a quiet window and rebase by default, which is what the
	  sticky-header engine has always done. It costs a 100ms hole in delta
	  reporting on every URL-bar animation, in exchange for swallowing the
	  phantom scroll deltas iOS reports while that chrome slides. Which trade is
	  better is an on-device question, so it is a flag rather than a decision —
	  set it false to keep deltas live through a height-only resize. Width
	  changes (a real resize or a rotation) always quiet, regardless.
	*/
	quietOnHeightResize: true,

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
	_rmq: undefined,

	handlers: {},

	/* ------------------------------------------------------------- readonly */

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

	/* ---------------------------------------------------------- public api */

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
			// an unsubscribe from inside a frame callback must not fire this
			// subscriber again in the same pass, which iterates a snapshot
			active: true,
			/** Wakes the loop without a scroll — observers, attribute changes. */
			tick: () => _.tick(),
			unsubscribe: () => _._unsubscribe(sub),
		};

		_._subs.push(sub);
		if (_._subs.length === 1) _._start();
		// a new subscriber gets a frame straight away rather than waiting for
		// the next scroll, so it can paint the current position
		_.tick();
		return sub;
	},

	/**
	 * Re-anchors scroll tracking to the current position, producing no delta on
	 * the next frame. Consumers call this from their own `refresh()` paths.
	 * @param {string} [reason='manual'] - 'restore' | 'resize' | 'manual'
	 */
	rebase(reason = 'manual') {
		const _ = this;
		_._refreshMaxScroll();
		const y = clamp(_._rawY(), 0, _._maxScrollY);
		// both anchors, or the very next scroll event would feed the whole
		// adopted jump into the velocity EMA
		_._lastScrollY = y;
		_._lastEventY = y;
		_._emit('rebase', reason);
		_.tick();
	},

	/**
	 * Opens a window in which scroll deltas are reported as zero. Public because
	 * a consumer that knows it is about to move the page (a programmatic scroll,
	 * a layout swap) can suppress the phantom gesture that follows.
	 */
	quiet() {
		this._quietUntil = this._now() + RESIZE_QUIET_MS;
	},

	/** Wakes the rAF loop without a scroll. */
	tick() {
		const _ = this;
		if (!_._listening) return;
		if (_._rafId !== null) return;
		if (typeof requestAnimationFrame !== 'function') return;
		_._rafId = requestAnimationFrame(_.handlers.frame);
	},

	/* --------------------------------------------------------- lifecycle */

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

		// bound once and reused, so add/removeEventListener see one reference
		const h = _.handlers;
		h.frame = h.frame || _.onFrame.bind(_);
		h.scroll = h.scroll || _.onScroll.bind(_);
		h.rest = h.rest || _.onRest.bind(_);
		h.resize = h.resize || _.onResize.bind(_);
		h.restore = h.restore || _.onRestore.bind(_);
		h.motionPreference = h.motionPreference || _.onMotionPreference.bind(_);

		window.addEventListener('scroll', h.scroll, { passive: true });
		window.addEventListener('scrollend', h.rest, { passive: true });
		window.addEventListener('resize', h.resize, { passive: true });
		window.visualViewport?.addEventListener('resize', h.resize, { passive: true });
		// browser scroll restoration lands after DOMContentLoaded
		window.addEventListener('load', h.restore, { passive: true });
		window.addEventListener('pageshow', h.restore, { passive: true });
		_._motionQuery()?.addEventListener?.('change', h.motionPreference);

		_._listening = true;
		_._refreshMaxScroll();
		_._lastScrollY = _._lastEventY = clamp(_._rawY(), 0, _._maxScrollY);
		_._lastWidth = _._width();
		_._lastEventTime = 0;
		_._lastFrameTime = 0;

		/*
		  Scroll restoration can land after this point; the first scroll that
		  arrives is then a restore, not a gesture, and must not become a delta.
		  Only while a restoration can still ARRIVE, though — `load` / `pageshow`
		  are what clear this flag, and neither fires again for a handler started
		  after them (an SPA route, a late import). Arming unconditionally leaves
		  the flag set forever, and the first real gesture gets eaten by a rebase.
		  A late start has already adopted the current position two lines up.
		*/
		_._rebaseOnNextScroll = typeof document !== 'undefined' && document.readyState !== 'complete';
	},

	_stop() {
		const _ = this;
		const h = _.handlers;

		if (_._listening) {
			window.removeEventListener('scroll', h.scroll);
			window.removeEventListener('scrollend', h.rest);
			window.removeEventListener('resize', h.resize);
			window.visualViewport?.removeEventListener('resize', h.resize);
			window.removeEventListener('load', h.restore);
			window.removeEventListener('pageshow', h.restore);
			_._motionQuery()?.removeEventListener?.('change', h.motionPreference);
		}

		clearTimeout(_._idleTimer);
		if (_._rafId !== null && typeof cancelAnimationFrame === 'function') {
			cancelAnimationFrame(_._rafId);
		}
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

	/* ---------------------------------------------------------- listeners */

	onScroll() {
		const _ = this;
		const now = _._now();

		if (_._rebaseOnNextScroll) {
			// a restored scroll position, not a gesture — adopt it with no delta
			_._rebaseOnNextScroll = false;
			_.rebase('restore');
		} else if (!_._restPending) {
			// the first event of a new gesture. The page may have grown or shrunk
			// since the last one, and this is the cheapest place to pay for the
			// `scrollHeight` read that refreshing the cache costs — once per
			// gesture rather than once per frame.
			_._refreshMaxScroll();
		}

		const raw = _._rawY();
		if (raw > _._maxScrollY) _._refreshMaxScroll();
		const y = clamp(raw, 0, _._maxScrollY);
		const delta = now < _._quietUntil ? 0 : y - _._lastEventY;
		_._lastEventY = y;

		/*
		  Velocity is an EMA over scroll-EVENT deltas, decayed per FRAME (see
		  onFrame). Events are the better sample: they arrive with the real
		  scroll steps, where a frame can see two events' worth or none at all.

		  The EMA weight is a time constant rather than a fixed 0.15, so a
		  browser that coalesces scroll events (or one that fires them at 120Hz)
		  weights each sample by how much time it actually represents.
		*/
		if (_.reducedMotion) {
			_._velocity = 0;
		} else {
			const eventDt =
				_._lastEventTime > 0
					? clamp(now - _._lastEventTime, 0, MAX_FRAME_DELTA)
					: REFERENCE_FRAME_MS;
			const factor = 1 - Math.exp(-eventDt / EMA_TAU);
			_._velocity = clamp(
				_._velocity + (delta - _._velocity) * factor,
				-MAX_VELOCITY,
				MAX_VELOCITY
			);
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
		// nothing has moved since the last rest — a stray `scrollend`, or the
		// fallback firing behind one
		if (!_._restPending) return;
		_._restPending = false;
		_._emit('rest');
		_.tick();
	},

	/** Scroll restoration / bfcache return: adopt the position, no delta. */
	onRestore() {
		this._rebaseOnNextScroll = false;
		this.rebase('restore');
	},

	onResize() {
		const _ = this;
		const width = _._width();
		const widthChanged = width !== _._lastWidth;
		_._lastWidth = width;

		// a snapshot, not the singleton: subscribers get the two numbers they
		// were promised and no handle on the probe's internals
		const refreshed = ViewportMetrics.refresh();
		const metrics = {
			currentHeight: refreshed.currentHeight,
			stableHeight: refreshed.stableHeight,
		};

		// the scroll RANGE always changes with the viewport height, whichever
		// branch below runs — this is one of the three places the cache is
		// allowed to cost a `scrollHeight` read
		_._refreshMaxScroll();

		/*
		  Two very different events arrive on the same listener.

		  A WIDTH change is a real resize — a rotation, a window drag, a desktop
		  reflow. Layout has moved, every cached geometry is stale, and a scroll
		  delta measured across it is meaningless. Quiet the window and re-adopt
		  the position.

		  A HEIGHT-ONLY change is almost always mobile chrome: the URL bar
		  collapsing or expanding, or a soft keyboard. The page did not reflow
		  horizontally and the scroll position is still the user's — but iOS
		  reports phantom scroll deltas for the whole chrome animation, which is
		  why quieting is the default. `quietOnHeightResize` exists so an
		  on-device test can flip that without touching this file.
		*/
		if (widthChanged || _.quietOnHeightResize) {
			_.quiet();
			_.rebase('resize');
		}

		_._emit('resize', metrics);
		_.tick();
	},

	onMotionPreference() {
		// a preference flip is not a position change, so it is not a rebase —
		// only the velocity signal, which reduced motion pins to zero, is stale
		this._velocity = 0;
		this.tick();
	},

	/*
	  Arms the rest fallback.

	  This is driven by actual MOVEMENT, not just by scroll events, and that
	  distinction is the subtlest correctness point in the module. A scroll
	  event can land a frame BEFORE the delta it describes: the idle it arms
	  then fires while the page is still moving, consumers commit to a rest, and
	  the trailing delta arrives to contradict it — with nothing left to re-arm,
	  since the events had already stopped.

	  Re-arming from the frame loop on every non-zero delta means the last real
	  movement always gets the final word. It is also what makes iOS momentum
	  work: rest keeps being pushed out until the decay truly ends, rather than
	  being declared 120ms after the last `scroll` event of a flick that is
	  still gliding.
	*/
	_armIdle() {
		const _ = this;
		_._restPending = true;
		clearTimeout(_._idleTimer);
		_._idleTimer = setTimeout(_.handlers.rest, IDLE_MS);
	},

	/* --------------------------------------------------------------- loop */

	/**
	 * One frame. Reads first, computes, then dispatches — every subscriber sees
	 * the same numbers, and no callback can invalidate a read for the next one.
	 * @param {number} now - rAF timestamp
	 */
	onFrame(now) {
		const _ = this;
		_._rafId = null;

		// ---- reads (once, before any callback runs) ----
		const rawY = _._rawY();
		// the cache is refreshed lazily: on resize, at gesture start, and here
		// when the position has run past it (a grown page, a bottom rubber-band).
		// Reading `scrollHeight` every frame would force layout every frame.
		if (rawY > _._maxScrollY) _._refreshMaxScroll();
		// clamping kills iOS rubber-band at BOTH ends: a negative `scrollY` at
		// the top and an over-scrolled one at the bottom both report the edge
		const y = clamp(rawY, 0, _._maxScrollY);

		const quiet = now < _._quietUntil;
		let delta = y - _._lastScrollY;
		_._lastScrollY = y;
		if (quiet) delta = 0;

		/*
		  Frame delta, from the rAF clock only. A woken loop has no previous
		  timestamp, and a long gap (a background tab, a blocked main thread)
		  must not translate into one huge easing step — hence the 64ms ceiling
		  and the 16ms first-frame default. The floor of 0 covers a rAF
		  timestamp that predates its predecessor, which idle and occluded pages
		  have been observed to produce.
		*/
		const dt =
			_._lastFrameTime > 0 ? clamp(now - _._lastFrameTime, 0, MAX_FRAME_DELTA) : FIRST_FRAME_DELTA;
		_._lastFrameTime = now;

		const reduced = _.reducedMotion;

		// real movement this frame — push rest detection out from HERE
		if (delta !== 0) _._armIdle();

		// ---- compute ----
		if (reduced) {
			_._velocity = 0;
		} else {
			// time-constant decay, so a 120Hz display decays at the same rate per
			// millisecond as a 60Hz one rather than twice as fast
			_._velocity *= Math.exp(-dt / VELOCITY_DECAY_TAU);
			if (Math.abs(_._velocity) < VELOCITY_THRESHOLD) _._velocity = 0;
		}

		const packet = {
			y,
			rawY,
			delta,
			velocity: _._velocity,
			dt,
			now,
			quiet,
			reducedMotion: reduced,
		};

		// ---- dispatch ----
		// a snapshot, so subscribing or unsubscribing from inside a frame
		// callback cannot mutate the list mid-iteration
		let wantsFrame = false;
		const subs = _._subs.slice();
		for (const sub of subs) {
			if (!sub.active) continue;
			if (safeCall(sub.frame, packet) === true) wantsFrame = true;
		}

		/*
		  Self-terminating: the loop only re-arms while something is actually
		  moving. `delta !== 0` cannot spin — it is true only on a frame where
		  the position CHANGED, and the frame after a stopped scroll reads the
		  same y and lets the loop sleep. It is in the condition so consumers
		  always get one frame after the last movement, which matters for
		  anything integrating deltas, and so scrolling still delivers frames
		  under reduced motion, where velocity is pinned to 0.
		*/
		if (_._velocity !== 0 || delta !== 0 || wantsFrame) {
			_.tick();
		} else {
			_._lastFrameTime = 0;
		}
	},

	/* -------------------------------------------------------------- utils */

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
		const doc = typeof document !== 'undefined' ? document.documentElement : null;
		const height = doc ? doc.scrollHeight : 0;
		// the LAYOUT viewport, not the stable 100svh probe: this has to match the
		// range the browser will actually let the page scroll through
		const viewport = typeof window !== 'undefined' ? window.innerHeight || 0 : 0;
		this._maxScrollY = Math.max(0, height - viewport);
	},

	/** @returns {number} Unclamped `window.scrollY`. */
	_rawY() {
		const y = typeof window === 'undefined' ? 0 : window.scrollY;
		return Number.isFinite(y) ? y : 0;
	},

	/** @returns {number} Layout viewport width, the resize classifier's input. */
	_width() {
		return typeof window === 'undefined' ? 0 : window.innerWidth || 0;
	},

	/**
	 * `performance.now()` shares its time origin with the rAF timestamp, so the
	 * quiet window (opened from an event, tested from a frame) can compare the
	 * two directly.
	 * @returns {number} Milliseconds on the shared clock
	 */
	_now() {
		return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
	},

	/**
	 * Resolved once, at first use rather than at import — the module must be
	 * importable without a DOM, and a test needs to stub `matchMedia` before it
	 * is read.
	 * @returns {object | null} The media query list, or null where unsupported
	 */
	_motionQuery() {
		if (this._rmq === undefined) {
			this._rmq =
				typeof window !== 'undefined' && typeof window.matchMedia === 'function'
					? window.matchMedia('(prefers-reduced-motion: reduce)')
					: null;
		}
		return this._rmq;
	},

	/** Test hook: tear everything down and forget every cached global. */
	_reset() {
		const _ = this;
		for (const sub of _._subs.slice()) sub.active = false;
		_._subs.length = 0;
		_._stop();
		_.handlers = {};
		_._rmq = undefined;
		_._lastScrollY = 0;
		_._lastEventY = 0;
		_._maxScrollY = 0;
		_._lastWidth = 0;
		_.quietOnHeightResize = true;
	},
};

export {
	ScrollHandler,
	expApproach,
	clamp,
	MAX_FRAME_DELTA,
	FIRST_FRAME_DELTA,
	IDLE_MS,
	RESIZE_QUIET_MS,
	MAX_VELOCITY,
	VELOCITY_THRESHOLD,
	VELOCITY_DECAY_TAU,
	EMA_TAU,
	REFERENCE_FRAME_MS,
};
