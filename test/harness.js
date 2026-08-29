/*
  Deterministic environment for the scroll-handler tests.

  Nothing here uses a real clock, a real rAF or a real layout. The harness
  installs:

    - a fake `requestAnimationFrame` that CAPTURES the callback instead of
      scheduling it, so every frame is fired by hand with an explicit dt —
      which is what lets one test run the same wall-clock span at 60Hz, at
      120Hz, and through a dropped-frame pattern
    - a `performance.now()` reading one fake clock, advanced in lockstep with
      vitest's fake `setTimeout` so the rest fallback fires at the right
      simulated moment
    - writable `scrollY` / `innerWidth` / `innerHeight` / `scrollHeight` /
      `readyState`, and a `matchMedia` stub jsdom does not provide

  Every test tears the environment down and calls `ScrollHandler._reset()`:
  the handler is a module singleton, so state leaks across tests otherwise.
*/

import { vi } from 'vitest';
import { ScrollHandler, REFERENCE_FRAME_MS } from '../src/lib/scroll-handler.js';
import { ViewportMetrics } from '../src/lib/viewport-metrics.js';

/**
 * Overwrites a property, remembering how to put it back.
 * @param {object} target
 * @param {string} key
 * @param {*} value
 * @param {Array<Function>} undos
 */
function define(target, key, value, undos) {
	const original = Object.getOwnPropertyDescriptor(target, key);
	Object.defineProperty(target, key, { configurable: true, writable: true, value });
	undos.push(() => {
		if (original) Object.defineProperty(target, key, original);
		else delete target[key];
	});
}

/**
 * Builds a deterministic window for one test.
 * @param {object} [options]
 * @param {number} [options.scrollHeight=4000] - Document height in px
 * @param {number} [options.innerHeight=800] - Viewport height in px
 * @param {number} [options.innerWidth=1200] - Viewport width in px
 * @param {number} [options.scrollY=0] - Starting scroll position
 * @param {boolean} [options.reducedMotion=false] - What matchMedia reports
 * @param {string} [options.readyState='complete'] - document.readyState
 * @returns {object} The environment control surface
 */
export function createEnv({
	scrollHeight = 4000,
	innerHeight = 800,
	innerWidth = 1200,
	scrollY = 0,
	reducedMotion = false,
	readyState = 'complete',
} = {}) {
	const undos = [];
	const clock = { now: 1000 }; // a non-zero origin, like a real page
	let pending = null;
	let nextId = 1;

	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

	define(
		globalThis,
		'requestAnimationFrame',
		(cb) => {
			pending = cb;
			return nextId++;
		},
		undos
	);
	define(
		globalThis,
		'cancelAnimationFrame',
		() => {
			pending = null;
		},
		undos
	);
	define(performance, 'now', () => clock.now, undos);

	define(window, 'scrollY', scrollY, undos);
	define(window, 'innerWidth', innerWidth, undos);
	define(window, 'innerHeight', innerHeight, undos);
	define(document.documentElement, 'scrollHeight', scrollHeight, undos);

	const readyStateBox = { value: readyState };
	const readyDescriptor = Object.getOwnPropertyDescriptor(document, 'readyState');
	Object.defineProperty(document, 'readyState', {
		configurable: true,
		get: () => readyStateBox.value,
	});
	undos.push(() => {
		if (readyDescriptor) Object.defineProperty(document, 'readyState', readyDescriptor);
		else delete document.readyState;
	});

	const motionListeners = new Set();
	const mql = {
		matches: reducedMotion,
		media: '(prefers-reduced-motion: reduce)',
		addEventListener: (_name, fn) => motionListeners.add(fn),
		removeEventListener: (_name, fn) => motionListeners.delete(fn),
	};
	define(window, 'matchMedia', () => mql, undos);

	const env = {
		clock,

		/** @returns {number} The fake clock in ms. */
		get now() {
			return clock.now;
		},

		/** @returns {boolean} Whether a frame is scheduled. */
		get frameScheduled() {
			return pending !== null;
		},

		/**
		 * Moves the fake clock and the fake timer queue together.
		 * @param {number} ms
		 */
		advance(ms) {
			clock.now += ms;
			// a negative step exists only to simulate an out-of-order rAF
			// timestamp; the timer queue cannot run backwards
			if (ms > 0) vi.advanceTimersByTime(ms);
		},

		/**
		 * Advances by `dt` and runs the scheduled frame with the new timestamp.
		 * @param {number} [dt=16.667] - Simulated ms since the previous frame
		 */
		frame(dt = REFERENCE_FRAME_MS) {
			env.advance(dt);
			const callback = pending;
			if (!callback) throw new Error('no frame scheduled');
			pending = null;
			callback(clock.now);
		},

		/**
		 * Sets the scroll position without telling anyone.
		 * @param {number} y
		 */
		setScrollY(y) {
			window.scrollY = y;
		},

		/**
		 * Sets the scroll position and fires a scroll event.
		 * @param {number} y
		 */
		scrollTo(y) {
			window.scrollY = y;
			window.dispatchEvent(new Event('scroll'));
		},

		/** Fires the browser's native end-of-scroll event. */
		scrollEnd() {
			window.dispatchEvent(new Event('scrollend'));
		},

		/**
		 * @param {number} height - New document height in px
		 */
		setScrollHeight(height) {
			document.documentElement.scrollHeight = height;
		},

		/**
		 * Resizes the viewport and fires a resize event.
		 * @param {object} size
		 * @param {number} [size.width]
		 * @param {number} [size.height]
		 */
		resize({ width, height } = {}) {
			if (width !== undefined) window.innerWidth = width;
			if (height !== undefined) window.innerHeight = height;
			window.dispatchEvent(new Event('resize'));
		},

		/**
		 * @param {string} name - 'load' or 'pageshow'
		 */
		fireWindow(name) {
			window.dispatchEvent(new Event(name));
		},

		/**
		 * @param {boolean} value - What the media query should report
		 */
		setReducedMotion(value) {
			mql.matches = value;
			for (const fn of motionListeners) fn({ matches: value });
		},

		/**
		 * @param {string} value - document.readyState
		 */
		setReadyState(value) {
			readyStateBox.value = value;
		},

		teardown() {
			ScrollHandler._reset();
			ViewportMetrics._reset();
			pending = null;
			for (const undo of undos.reverse()) undo();
			vi.useRealTimers();
		},
	};

	return env;
}

/**
 * Subscribes and records everything the handler reports.
 * @param {object} [options]
 * @param {boolean} [options.keepAwake=false] - Return true from every frame,
 *   which holds the loop open (and so preserves `_lastFrameTime`).
 * @returns {object} `{ sub, frames, rests, rebases, resizes, last }`
 */
export function record({ keepAwake = false } = {}) {
	const frames = [];
	const rests = [];
	const rebases = [];
	const resizes = [];

	const sub = ScrollHandler.subscribe({
		frame(packet) {
			frames.push({ ...packet });
			return keepAwake ? true : undefined;
		},
		rest() {
			rests.push(performance.now());
		},
		rebase(reason) {
			rebases.push(reason);
		},
		resize(metrics) {
			resizes.push(metrics);
		},
	});

	return {
		sub,
		frames,
		rests,
		rebases,
		resizes,
		/** @returns {object} The most recent frame packet. */
		get last() {
			return frames[frames.length - 1];
		},
	};
}
