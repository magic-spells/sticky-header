/*
  Viewport metrics — a module singleton reporting two heights.

    currentHeight   the live visual viewport, which mobile chrome moves
    stableHeight    the `100svh` height, which it does not

  Mobile browsers grow and shrink the visual viewport as their chrome slides
  away, so `innerHeight` changes mid-scroll and every px range resolved from it
  moves under the user. A `100svh` probe measures the SMALL viewport (the height
  with the chrome showing), which stays put through that whole animation, so
  ranges computed against it stay put too.

  Nothing here touches `document`, `window` or `CSS` at import time: the module
  has to be importable in Node (the test suite does exactly that), and every
  global is read at call time, which is also what lets tests stub them.

  The probe is created once and never removed — it is a zero-sized hidden div,
  and re-creating it per read would be a layout thrash. `init()` is re-entrant
  and re-tried from `refresh()`, so a host that has no DOM yet simply keeps
  falling back to the live height, and one that gains a DOM later starts
  measuring.
*/

/** Parks the probe outside layout, painting, hit-testing and a11y. */
const CONTAINER_STYLE =
	'position: fixed; top: 0; left: 0; width: 0; height: 0; ' +
	'overflow: hidden; visibility: hidden; pointer-events: none; z-index: -1;';

/**
 * The live viewport height, used until (or unless) a probe exists.
 * @returns {number} Height in px, 0 with no host environment
 */
function liveHeight() {
	return globalThis.visualViewport?.height || globalThis.innerHeight || 0;
}

const ViewportMetrics = {
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
		if (typeof document === 'undefined' || !document.documentElement) return this;

		// `100svh` is the whole point — without support there is no stable height
		// to measure and the live viewport is as good as it gets.
		const css = globalThis.CSS;
		if (typeof css?.supports !== 'function' || !css.supports('height: 100svh')) return this;

		const container = document.createElement('div');
		const probe = document.createElement('div');
		container.setAttribute('aria-hidden', 'true');
		container.style.cssText = CONTAINER_STYLE;
		probe.style.height = '100svh';
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
		// a probe that measures 0 is detached or inside a hidden ancestor — the
		// live height is the honest answer there, not zero
		const measured = this.probe ? this.probe.getBoundingClientRect().height : 0;

		this.currentHeight = currentHeight;
		this.stableHeight = measured || currentHeight;

		return this;
	},

	/** Test hook: detach the probe so the next `refresh()` starts clean. */
	_reset() {
		if (typeof this.container?.remove === 'function') this.container.remove();
		this.container = null;
		this.probe = null;
		this.currentHeight = 0;
		this.stableHeight = 0;
	},
};

export { ViewportMetrics };
