/*
  <sticky-content> — a sticky element that rides the header's offset.

  The rider is positioned entirely by CSS: its sticky inset is
      top: calc(var(--sticky-content-top, var(--header-group-height)) + var(--header-group-offset))
  so the inset itself moves with the header. A moving inset is continuous at
  every scroll position — the browser pins the element at
  max(flowTop, base + offset) on its own, which means a rider that first pins
  while the header is already hidden arrives at the right place with no jump.
  (Transforming the rider and gating that on a stuck flag is what produces the
  jump this design avoids.)

  JS contributes only two things: the resolved base inset (cached, so the
  per-frame stuck test costs one rect read) and the `[stuck]` attribute.

  With no <sticky-header> on the page this degrades to a plain sticky element
  that still gets `[stuck]`.
*/

import { ScrollEngine } from '../lib/scroll-engine.js';

/**
 * Sticky element that follows the sticky header's offset.
 */
class StickyContent extends HTMLElement {
	#baseTop = null;
	#initialized = false;
	// whether the inline --sticky-content-top declaration is OURS, written from
	// the `top` attribute — and whatever author value it displaced
	#ownsTop = false;
	#authorTop = null;

	handlers = {};

	static get observedAttributes() {
		return ['top', 'disabled'];
	}

	connectedCallback() {
		if (document.readyState === 'loading') {
			// a reconnect before DOMContentLoaded must not leak a second listener
			if (this.handlers.ready) return;
			this.handlers.ready = () => {
				this.handlers.ready = null;
				this.#init();
			};
			document.addEventListener('DOMContentLoaded', this.handlers.ready, { once: true });
			return;
		}
		this.#init();
	}

	disconnectedCallback() {
		const _ = this;
		if (_.handlers.ready) {
			document.removeEventListener('DOMContentLoaded', _.handlers.ready);
			_.handlers.ready = null;
		}
		if (!_.#initialized) return;
		_.#initialized = false;

		ScrollEngine.unregisterRider(_);
		_.#baseTop = null;
		_.removeAttribute('stuck');
		// only an inline var WE wrote goes with us — an author's own
		// `style="--sticky-content-top: …"` is theirs and stays put
		_.#releaseTop();
	}

	attributeChangedCallback(name, previousValue, currentValue) {
		if (!this.#initialized || previousValue === currentValue) return;
		if (name === 'top') this.#applyTop();
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

	/*
	  The `top` attribute is sugar for setting `--sticky-content-top` inline —
	  but sugar does not get to own a declaration it did not write.
	  `<sticky-content style="--sticky-content-top: 6rem">` is a documented form,
	  and removing that inline value on connect (or on disconnect, or when the
	  attribute goes away) drops the rider back to --header-group-height.

	  So ownership is tracked: an author value the attribute overwrites is
	  captured and handed back when we let go. A stylesheet rule was never at
	  risk — removeProperty only touches the inline declaration.
	*/
	#applyTop() {
		const _ = this;
		const value = _.getAttribute('top');
		if (value === null || value === '') {
			_.#releaseTop();
			return;
		}
		if (!_.#ownsTop) {
			_.#authorTop = _.style.getPropertyValue('--sticky-content-top');
			_.#ownsTop = true;
		}
		_.style.setProperty('--sticky-content-top', value);
	}

	/** Gives the inline declaration back, if it was ours to give. */
	#releaseTop() {
		const _ = this;
		if (!_.#ownsTop) return;
		_.#ownsTop = false;
		const author = _.#authorTop;
		_.#authorTop = null;
		if (author) _.style.setProperty('--sticky-content-top', author);
		else _.style.removeProperty('--sticky-content-top');
	}

	// ---- engine-facing accessors ----

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
		const applied =
			ScrollEngine.header && ScrollEngine.lastWritten !== null ? ScrollEngine.lastWritten : 0;
		this.#baseTop = Number.isFinite(resolved) ? resolved - applied : 0;
		return this.#baseTop;
	}

	_invalidateTop() {
		this.#baseTop = null;
	}

	// ---- public api ----

	/** Whether the rider is pinned at its effective sticky top. */
	get stuck() {
		return this.hasAttribute('stuck');
	}

	/** The resting sticky inset in px, excluding the header offset. */
	get top() {
		return this._baseTop();
	}
}

if (!customElements.get('sticky-content')) {
	customElements.define('sticky-content', StickyContent);
}

export { StickyContent };
