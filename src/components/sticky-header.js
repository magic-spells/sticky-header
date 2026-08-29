/*
  <sticky-header> — the sticky container that follows the scroll.

  The element owns everything the engine shouldn't know about: attributes,
  measurement, breakpoint gating, lock conditions, and the public API. Motion itself belongs to ScrollEngine, which reaches
  back through the `_`-prefixed accessors below.

  JS never writes `transform` — it maintains height custom properties and the
  single `--header-group-offset` on <body>. The CSS in this package (and any
  author element that wants to ride along) reads that var.
*/

import { ScrollEngine, clamp } from '../lib/scroll-engine.js';

const DEFAULTS = {
	hideOnScroll: 'both',
	breakpoint: 1024,
	revealThreshold: 100,
	settleThreshold: 0.5,
	settleDuration: 900,
	settleOvershoot: 0.05,
};

const HIDE_MODES = ['none', 'mobile', 'desktop', 'both'];
const HEIGHT_EPSILON = 1; // px a measurement must move before vars are rewritten

// marks an element that should come BACK on a mid-page scroll up. Everything
// above the topmost active one is top-only: visible near the page top only.
const REVEAL_ATTRIBUTE = 'data-sticky-reveal';

// unrecognized reveal values already warned about, so a re-render can't spam
const warnedRevealValues = new Set();

/**
 * @param {NodeList} nodes - Mutation record node list
 * @returns {boolean} Whether it contains an element node
 */
function hasElement(nodes) {
	for (const node of nodes) {
		if (node.nodeType === 1) return true;
	}
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
class StickyHeader extends HTMLElement {
	#config = { ...DEFAULTS };
	#geometry = {
		headerHeight: 0,
		announcementHeight: 0,
		groupHeight: 0,
		stickyTop: 0,
		topOnlyHeight: 0,
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
			'hide-on-scroll',
			'breakpoint',
			'reveal-threshold',
			'settle-threshold',
			'settle-duration',
			'settle-overshoot',
			'lock',
			'locked',
			'disabled',
			'hover-lock',
		];
	}

	connectedCallback() {
		// upgrading before children parse would measure an empty group
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
		// a rejected duplicate never initialized, so it owns nothing to tear down
		if (!_.#initialized) return;
		_.#initialized = false;

		_.#resizeObserver?.disconnect();
		_.#resizeObserver = null;
		_.#lockObserver?.disconnect();
		_.#lockObserver = null;
		_.#revealObserver?.disconnect();
		_.#revealObserver = null;
		_.#mediaQuery?.removeEventListener('change', _.handlers.media);
		_.#mediaQuery = null;
		_.removeEventListener('pointerenter', _.handlers.pointerEnter);
		_.removeEventListener('pointerleave', _.handlers.pointerLeave);
		_.#hovered = false;
		_.#hoverQuery = null;
		_.removeAttribute('data-hidden');
		_.removeAttribute('data-tracking');

		// the body vars go with the engine, so the next connect has to publish
		// them again from scratch — a stale geometry would early-return instead
		_.#measured = false;
		_.#geometry = {
			headerHeight: 0,
			announcementHeight: 0,
			groupHeight: 0,
			stickyTop: 0,
			topOnlyHeight: 0,
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

		if (name === 'lock') {
			this.#lockDirty = true;
			this.#observeLocks();
		} else if (name === 'breakpoint' || name === 'hide-on-scroll') {
			this.#parseConfig();
			this.#observeMedia();
			ScrollEngine.rebase();
			// both change which tags are active, and hide-on-scroll also flips the
			// position-based glide on or off, so the stops have to be re-resolved
			this.#revealDirty = true;
			this._readReveal();
			this._writeReveal();
			ScrollEngine.onStopsChanged();
		} else if (name === 'locked') {
			this.#lockDirty = true;
		} else {
			this.#parseConfig();
		}

		ScrollEngine.tick();
	}

	// ---- setup ----

	#init() {
		const _ = this;
		if (_.#initialized) return;

		// parsing is side-effect free, so it is safe before the ownership check
		_.#parseConfig();

		// a rejected duplicate must be COMPLETELY inert: no stamping, no
		// observers, no rebase, and a disconnect that tears nothing down
		if (!ScrollEngine.registerHeader(_)) return;
		_.#initialized = true;

		_.queryDOM();
		_.attachListeners();
		_.#hoverQuery = window.matchMedia('(hover: hover) and (pointer: fine)');
		_.addEventListener('pointerenter', _.handlers.pointerEnter);
		_.addEventListener('pointerleave', _.handlers.pointerLeave);
		_.#observeMedia();
		_.#observeTargets();
		_.#observeLocks();
		_.#observeReveal();
		_._measure();
		ScrollEngine.tick();
	}

	queryDOM() {
		this.#announcementElement = this.querySelector('[data-announcement]');
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

	/*
	  hover-lock. `pointerenter`/`pointerleave` do not bubble and treat an
	  element plus its whole subtree as one region, which is exactly the
	  semantics wanted here: anything rendered inside the header — an open
	  dropdown panel included, since it is a DOM child — counts as "in the
	  header" for free, and the whole sliding group is inside the host.
	*/
	#onPointerEnter() {
		this.#hovered = true;
		ScrollEngine.tick();
	}

	#onPointerLeave() {
		this.#hovered = false;
		// normal rules resume immediately; no phantom delta has accumulated
		// because the scroll handler owns the delta base and keeps advancing it
		// every frame, locked or not
		ScrollEngine.tick();
	}

	/**
	 * Whether the pointer is parked in the header group with hover-lock on.
	 * Gated to hover-capable fine pointers — on touch, `pointerenter` sticks
	 * after a tap and would wedge the header permanently open.
	 * @returns {boolean} True while hover should hold the header visible
	 */
	#isHoverLocked() {
		if (!this.hasAttribute('hover-lock')) return false;
		if (!this.#hovered) return false;
		return this.#hoverQuery ? this.#hoverQuery.matches : false;
	}

	#parseConfig() {
		const _ = this;
		const mode = (_.getAttribute('hide-on-scroll') || '').toLowerCase();
		_.#config = {
			hideOnScroll: HIDE_MODES.includes(mode) ? mode : DEFAULTS.hideOnScroll,
			breakpoint: parseNumber(_.getAttribute('breakpoint'), DEFAULTS.breakpoint, 1, 100000),
			revealThreshold: parseNumber(
				_.getAttribute('reveal-threshold'),
				DEFAULTS.revealThreshold,
				0,
				100000
			),
			settleThreshold: parseNumber(
				_.getAttribute('settle-threshold'),
				DEFAULTS.settleThreshold,
				0,
				1
			),
			settleDuration: parseNumber(
				_.getAttribute('settle-duration'),
				DEFAULTS.settleDuration,
				1,
				5000
			),
			settleOvershoot: parseNumber(
				_.getAttribute('settle-overshoot'),
				DEFAULTS.settleOvershoot,
				0,
				0.2
			),
		};
	}

	#observeMedia() {
		const _ = this;
		_.#mediaQuery?.removeEventListener('change', _.handlers.media);
		_.#mediaQuery = window.matchMedia(`(min-width: ${_.#config.breakpoint}px)`);
		_.#mediaQuery.addEventListener('change', _.handlers.media);
	}

	#onMediaChange() {
		const _ = this;
		// rebasing first means crossing the breakpoint never produces a phantom
		// delta; the engine's own guard then settles a now-inactive side visible
		ScrollEngine.rebase();
		// which tags apply is a function of the breakpoint, so the boundary is
		// re-resolved and re-measured before the engine picks its new resting stop
		_.#revealDirty = true;
		_._readReveal();
		_._writeReveal();
		ScrollEngine.onStopsChanged();
		ScrollEngine.tick();
	}

	/*
	  Live re-query of the reveal tags. The Shopify theme editor re-renders a
	  whole section when its settings change, so both halves matter: childList
	  catches the re-render, and the attribute filter catches a tag value edited
	  in place. Nothing this component writes is inside the observed set — the
	  host's own data-hidden/data-tracking are filtered out — so the observer
	  can't wake itself.

	  childList + subtree is broad, though: it also fires on ordinary text churn
	  inside the header, a cart count ticking over being the obvious one. The
	  handler filters those out and never measures inline — see #onRevealMutation.
	*/
	#observeReveal() {
		const _ = this;
		_.#revealObserver?.disconnect();
		_.#revealObserver = new MutationObserver(_.handlers.revealMutation);
		_.#revealObserver.observe(_, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: [REVEAL_ATTRIBUTE],
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
		// text churn inside the header — a cart count ticking over, a live region
		// updating — cannot move the boundary. Only a tag edit or an ELEMENT
		// entering/leaving the subtree can.
		let relevant = false;
		for (const record of records) {
			if (
				record.type === 'attributes' ||
				hasElement(record.addedNodes) ||
				hasElement(record.removedNodes)
			) {
				relevant = true;
				break;
			}
		}
		if (!relevant) return;

		this.#revealDirty = true;
		ScrollEngine.tick();
	}

	#observeTargets() {
		const _ = this;
		_.#resizeObserver?.disconnect();
		if (!('ResizeObserver' in window)) return;
		_.#resizeObserver = new ResizeObserver(_.handlers.resizeObserved);
		_.#resizeObserver.observe(_);
		if (_.#announcementElement) _.#resizeObserver.observe(_.#announcementElement);
	}

	/*
	  Lock watching stays as narrow as correctness allows. `open` covers the
	  built-in dialog[open] rule; anything else comes from attribute names
	  parsed out of the author's own `lock` selector, plus `class` only when the
	  selector actually uses one — a blanket attribute observer would wake the
	  loop on every unrelated attribute write on the page.

	  childList is unavoidable though: a <dialog open> inserted already-open, or
	  a lock target conditionally rendered by a framework, never fires an
	  attribute mutation at all. The handler is a flag set plus a tick, so the
	  cost of the extra notifications is negligible.
	*/
	#observeLocks() {
		const _ = this;
		_.#lockObserver?.disconnect();
		const filter = new Set(['open']);
		const selector = _.getAttribute('lock');
		if (selector) {
			for (const match of selector.matchAll(/\[\s*([\w-]+)/g)) filter.add(match[1]);
			if (selector.includes('.')) filter.add('class');
		}
		_.#lockObserver = new MutationObserver(_.handlers.lockMutation);
		_.#lockObserver.observe(document.documentElement, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: [...filter],
		});
	}

	#onLockMutation() {
		this.#lockDirty = true;
		ScrollEngine.tick();
	}

	// ---- engine-facing accessors ----

	get _config() {
		return this.#config;
	}

	get _geometry() {
		return this.#geometry;
	}

	/** Whether hide-on-scroll applies at this viewport and the element is on. */
	_isActive() {
		if (this.hasAttribute('disabled')) return false;
		const mode = this.#config.hideOnScroll;
		if (mode === 'none') return false;
		if (mode === 'both') return true;
		const isDesktop = this.#mediaQuery ? this.#mediaQuery.matches : true;
		return mode === 'desktop' ? isDesktop : !isDesktop;
	}

	/** Force-show conditions. Re-queried only when a mutation marked it dirty. */
	_isLocked() {
		if (this.hasAttribute('locked')) return true;
		// evaluated outside the dirty-flag cache: hover changes on its own
		// schedule, with no mutation for the observer to notice
		if (this.#isHoverLocked()) return true;
		if (!this.#lockDirty) return this.#lockState;
		this.#lockDirty = false;

		let locked = !!document.querySelector('dialog[open]');
		const selector = this.getAttribute('lock');
		if (!locked && selector) {
			try {
				locked = !!document.querySelector(selector);
			} catch {
				console.warn(`<sticky-header> ignoring invalid lock selector "${selector}"`);
			}
		}
		this.#lockState = locked;
		return locked;
	}

	/*
	  The reveal boundary — the one number the three-stop model needs.

	  `topOnlyHeight` is the distance from the group top to the topmost ACTIVE
	  [data-sticky-reveal] element. Everything above it is top-only: it leaves
	  with the page and comes back only near the top. Everything from the
	  boundary down is what a mid-page scroll up brings back.

	  It is measured as a rect DIFFERENCE, `boundaryTop − hostTop`, for two
	  reasons. Nesting-proof: Shopify section wrappers are uncontrollable, so
	  the tag lands on the section's inner root and offsetTop would be relative
	  to whatever offset parent that wrapper happens to create. And
	  translate-invariant: both rects carry the group's transform equally, so
	  the difference is the same at every point of the travel — unless the host
	  is not the translating element, which is the one case #measureRevealHeight
	  corrects for.

	  Reads and the var write are split so the engine can take the reads in its
	  read phase and the write in its write phase.
	*/

	/**
	 * Dirty-gated re-resolve of the reveal boundary. Reads only — safe to call
	 * from the frame's read phase.
	 */
	_readReveal(groupHeight = this.#geometry.groupHeight) {
		const _ = this;
		if (!_.#revealDirty || !_.#initialized) return;
		_.#revealDirty = false;

		const height = _.#measureRevealHeight(groupHeight);
		// the same 1px epsilon every other measurement uses, compared against the
		// RAW measurement rather than the rounded one: subpixel jitter either side
		// of x.5 would otherwise flip the rounded value and force a full settle
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
		document.body.style.setProperty('--header-reveal-offset', `${height === 0 ? 0 : -height}px`);
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
		// nothing tagged at all — exactly the original two-stop behavior
		if (!targets.length) return 0;

		const isDesktop = _.#mediaQuery ? _.#mediaQuery.matches : true;
		const hostTop = _.getBoundingClientRect().top;
		// The rect difference is translate-invariant only while BOTH rects carry
		// the group transform — which is the package CSS, where the host is the
		// translating element. Under the documented `position: fixed` workaround
		// the host is `transform: none` and the translate sits on an inner
		// element, so the boundary rect carries the offset and the host rect does
		// not: the difference measures `true + offset` and the offset has to come
		// back out. Measured hidden at −129 that would read 64 − 129 = −65, clamp
		// to 0, and publish "nothing tagged" until the next measure at rest.
		const carried = getComputedStyle(_).transform === 'none' ? ScrollEngine.offset : 0;
		let boundary = null;

		for (const element of targets) {
			if (!_.#revealApplies(element.getAttribute(REVEAL_ATTRIBUTE), isDesktop)) continue;
			const rect = element.getBoundingClientRect();
			// a bar removed with `hidden` (or any display:none) has no box, so it
			// can't be the boundary — the next active tag down takes over
			if (!rect.width && !rect.height) continue;
			const top = rect.top - hostTop - carried;
			if (boundary === null || top < boundary) boundary = top;
		}

		// tagged elements exist but none apply at this breakpoint: the reveal stop
		// coincides with hidden, so a mid-page scroll up reveals nothing and the
		// whole group returns only near the top
		if (boundary === null) return groupHeight;
		return clamp(boundary, 0, groupHeight);
	}

	/**
	 * @param {string|null} value - Raw `data-sticky-reveal` value
	 * @param {boolean} isDesktop - Whether the breakpoint query matches
	 * @returns {boolean} Whether the tag applies at this viewport
	 */
	#revealApplies(value, isDesktop) {
		const mode = (value || '').trim().toLowerCase();
		if (mode === '' || mode === 'both') return true;
		if (mode === 'mobile') return !isDesktop;
		if (mode === 'desktop') return isDesktop;
		// `none` is inactive on purpose: a Liquid setting will often render the
		// string rather than omit the attribute, and a merchant who picked "never"
		// must not get an always-active boundary out of it. Anything else is a
		// typo, and treating a typo as inactive fails the safe way — the layer
		// stays top-only instead of silently pinning the whole stack.
		if (mode !== 'none' && !warnedRevealValues.has(mode)) {
			warnedRevealValues.add(mode);
			console.warn(
				`<sticky-header> ignoring unrecognized ${REVEAL_ATTRIBUTE}="${mode}" — expected both, mobile, desktop or none`
			);
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

		// re-query first, as a read: a Shopify section re-render REPLACES the
		// announcement node rather than resizing it, and a cached detached node
		// measures 0 — which would fold the whole group into --header-height and
		// leave the live node unobserved. Toggling `hidden` on the same node is a
		// different case and already correct: offsetHeight goes to 0 by itself.
		const previousAnnouncement = _.#announcementElement;
		_.queryDOM();
		// re-observe rather than add: the old node is detached, and #observeTargets
		// disconnects first, so nothing leaks an observation of it
		if (_.#announcementElement !== previousAnnouncement) _.#observeTargets();

		// the host IS the group; the announcement is whichever child is tagged
		const announcementHeight = _.#announcementElement ? _.#announcementElement.offsetHeight : 0;
		const headerHeight = _.offsetHeight - announcementHeight;
		const groupHeight = announcementHeight + headerHeight;

		// where the host pins, straight off its own resolved inset — the pinned
		// test compares an untranslated rect top against it, so a custom
		// `sticky-header { top: … }` has to be honoured rather than assumed 0
		const resolvedTop = parseFloat(getComputedStyle(_).top);
		const stickyTop = Number.isFinite(resolvedTop) ? resolvedTop : 0;
		const previous = _.#geometry;
		const changed =
			Math.abs(groupHeight - previous.groupHeight) >= HEIGHT_EPSILON ||
			Math.abs(headerHeight - previous.headerHeight) >= HEIGHT_EPSILON ||
			Math.abs(announcementHeight - previous.announcementHeight) >= HEIGHT_EPSILON ||
			Math.abs(stickyTop - previous.stickyTop) >= HEIGHT_EPSILON;

		// every re-measure is also a reason to re-measure the boundary: whatever
		// resized may well have moved it, even when the group height held. It is
		// read HERE, while this method is still reading — the incoming group height
		// is passed in because the boundary falls back to it, and #geometry has not
		// been replaced yet. Reading it after the style writes below would mean a
		// forced layout every time anything resizes.
		_.#revealDirty = true;
		_._readReveal(groupHeight);

		// the first measurement always publishes, even for a zero-height group,
		// so the height vars are defined before anything reads them
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
			// _readReveal above mutated the outgoing object, so this carries the
			// value it just measured, not a stale one
			topOnlyHeight: previous.topOnlyHeight,
		};

		// ---- writes ----
		const style = document.body.style;
		style.setProperty('--header-height', `${headerHeight}px`);
		style.setProperty('--announcement-bar-height', `${announcementHeight}px`);
		style.setProperty('--header-group-height', `${groupHeight}px`);

		// a shrinking group (announcement dismissed while hidden) has to pull the
		// offset — and any tween already aimed at the old bound — back into range.
		// BEFORE the stops are re-evaluated: re-settling first and re-clamping
		// after would invalidate the settle's own `from` a moment after it was
		// announced, and hold data-header-tracking for a tween going nowhere.
		ScrollEngine.reclamp(groupHeight);
		_._writeReveal();
		for (const rider of ScrollEngine.riders) rider._invalidateTop();

		_._emit('resize', { headerHeight, announcementHeight, groupHeight });
		ScrollEngine.tick();
	}

	/**
	 * @param {string} name - Event name after the `sticky-header:` prefix
	 * @param {object} detail - Event detail payload
	 */
	_emit(name, detail) {
		this.dispatchEvent(new CustomEvent(`sticky-header:${name}`, { detail, bubbles: true }));
	}

	// ---- public api ----

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
		return this.hasAttribute('data-hidden');
	}

	get groupHeight() {
		return this.#geometry.groupHeight;
	}

	/*
	  Everything below that reaches the engine is inert on a host that never
	  initialized — which is exactly the rejected duplicate, since only the
	  accepted host initializes. Without the guard a duplicate reaches the
	  singleton with its own zero geometry: hide() would request a settle to 0
	  and SHOW the live header, and refresh() would hand `new ResizeObserver` a
	  handler that was never bound.
	*/

	/**
	 * Plays the show settle. Normal resting rules resume the moment it lands, so
	 * mid-page on a tagged stack the next idle tucks to the reveal stop — use
	 * lock() to hold the group fully visible.
	 */
	show() {
		if (!this.#initialized) return;
		ScrollEngine.requestSettle(0, { reason: 'show', forced: true });
		ScrollEngine.tick();
	}

	/** Settles the header fully hidden. A no-op while locked or inactive. */
	hide() {
		if (!this.#initialized) return;
		// re-evaluate locks rather than trusting the cache: hiding against a lock
		// would be undone by the next frame's forced show, one frame later
		this.#lockDirty = true;
		if (this._isLocked() || !this._isActive()) return;
		ScrollEngine.requestSettle(-this.#geometry.groupHeight, { reason: 'hide', forced: true });
		ScrollEngine.tick();
	}

	/*
	  lock()/unlock() are deliberately NOT guarded: they only write the `locked`
	  attribute, which #init() honours whenever it runs. A guard would drop a
	  lock() called before init — the package as a blocking script in <head>
	  defers init to DOMContentLoaded, so author code in a deferred or module
	  script runs first — and that is exactly the lock()-before-jump pattern the
	  README recommends. On a rejected duplicate the attribute is inert: nothing
	  reads it.
	*/

	/** Force-show until unlock(). */
	lock() {
		this.setAttribute('locked', '');
	}

	unlock() {
		this.removeAttribute('locked');
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
}

if (!customElements.get('sticky-header')) {
	customElements.define('sticky-header', StickyHeader);
}

export { StickyHeader };
