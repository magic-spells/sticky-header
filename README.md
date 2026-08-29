# Sticky Header

A sticky header that **follows your scroll**. Instead of flipping between two states, the header translates at exactly the rate you scroll — glued to your finger — and only when scrolling stops does it settle to fully shown or fully hidden, whichever side of the commit threshold it landed on. Ships with `<sticky-content>` so other sticky elements ride the same offset. 7.9 kB JS gzip, 0.3 kB CSS gzip, no dependencies, no Shadow DOM.

[**Demo**](https://magic-spells.github.io/sticky-header/demo/)

## Install

```bash
npm install @magic-spells/sticky-header
```

```js
import '@magic-spells/sticky-header';
import '@magic-spells/sticky-header/css';
```

Or via CDN:

```html
<link
	rel="stylesheet"
	href="https://unpkg.com/@magic-spells/sticky-header/dist/sticky-header.min.css" />
<script src="https://unpkg.com/@magic-spells/sticky-header"></script>
```

## Usage

`<sticky-header>` **is** the sticky container. Everything that should slide together goes inside it:

```html
<sticky-header>
	<div data-announcement>Free shipping on everything</div>
	<header>
		<a href="/">Brand</a>
		<nav>…</nav>
	</header>
</sticky-header>
```

That's the whole setup. The element measures itself, publishes height custom properties, and starts tracking. Mark an announcement bar with `data-announcement` so its height is reported separately — it is not required.

### Multiple bars & scroll-up reveal

A header group is often a stack: a countdown bar, an announcement bar, then the header itself. Usually only part of that stack should come back when the user scrolls up mid-page — the countdown belongs at the top of the page and nowhere else.

Mark what should come back with `data-sticky-reveal`. The **topmost active tag is the reveal boundary**; everything above it is top-only.

That gives the group three resting stops:

| Stop       | Offset           | When                                                    |
| ---------- | ---------------- | ------------------------------------------------------- |
| Full stack | `0`              | Near the page top, inside `reveal-threshold`            |
| Revealed   | `−topOnlyHeight` | Mid-page, after a scroll up past the settle threshold   |
| Hidden     | `−groupHeight`   | Mid-page, after a scroll down past the settle threshold |

Scrolling down still hides the whole group. Scrolling up mid-page brings it back **only as far as the boundary**; the layers above it return when you reach the top of the page.

```html
<sticky-header hide-on-scroll="mobile">
	<div id="shopify-section-…__announcement-bar" class="shopify-section …">
		<section data-sticky-reveal="mobile" class="announcement"><p>Free shipping</p></section>
	</div>
	<div id="shopify-section-…__header" class="shopify-section …">
		<header data-sticky-reveal class="header">…</header>
	</div>
</sticky-header>
```

On mobile both tags are active, so the boundary is the announcement bar at offset `0` and the whole group returns on a scroll up. On desktop only the header is tagged, so the bar hides and a scroll up reveals the header alone.

The tag goes on **any descendant**, at any depth. That matters for Shopify: the `.shopify-section` wrapper divs are generated for you, but the section's own root element is yours, so the tag lands there. The boundary is measured as a rect difference against the host, which is nesting-proof.

| Value                          | Active                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `data-sticky-reveal`           | Always (same as `both`)                                                                                            |
| `data-sticky-reveal="both"`    | Always                                                                                                             |
| `data-sticky-reveal="mobile"`  | Below `breakpoint`                                                                                                 |
| `data-sticky-reveal="desktop"` | At or above `breakpoint`                                                                                           |
| `data-sticky-reveal="none"`    | Never — identical to leaving the attribute off, so a merchant setting can render the string instead of omitting it |

Any other value is inactive too, and warned about once in the console. Failing that way round is the safe one: the layer stays top-only rather than a typo silently pinning the whole stack open. An element with no box — hidden with `hidden` or `display: none` — is skipped, so the next active tag below it becomes the boundary.

Two edge cases are worth knowing:

- **No tags anywhere** — the boundary is the group top, which is exactly the two-stop behavior: everything hides, everything comes back.
- **Tags exist but none are active at this breakpoint** — the reveal stop coincides with hidden. A mid-page scroll up reveals nothing; the group returns only near the page top.

#### Where `hide-on-scroll` is off

On a viewport where the header never hides, tagged groups still do something useful: everything above the boundary **glides away with the page** while the header stays pinned. That motion is position-based rather than direction-based — the bars leave as you scroll down and return at the exact scroll position they left, just like non-sticky page content. No settle, no tween, and nothing to configure. It applies whenever a boundary sits strictly inside the group; if no tag is active at all, nothing moves.

#### Driving it from a Shopify setting

Map a merchant setting straight onto the attribute:

```json
{
	"type": "select",
	"id": "sticky_reveal",
	"label": "Return on scroll up",
	"options": [
		{ "value": "none", "label": "Never (top of page only)" },
		{ "value": "mobile", "label": "Mobile only" },
		{ "value": "desktop", "label": "Desktop only" },
		{ "value": "both", "label": "All screens" }
	],
	"default": "both"
}
```

```liquid
<section class="announcement" data-sticky-reveal="{{ section.settings.sticky_reveal }}">
	…
</section>
```

`none` renders straight through and is inactive, so the value maps one-to-one; omitting the attribute entirely for `none` behaves identically if you prefer that. Changing the setting in the theme editor re-renders the section, and the component re-resolves the boundary and re-measures without a reload.

**Migration note:** remove any `sticky` / `top-0` utility classes from the section wrappers inside the group. The component owns pinning for the whole group; a section that pins itself will fight the shared offset. Set stacking order with `--sticky-header-z-index` instead of a `z-` class on a wrapper.

### Riders

`<sticky-content>` pins below the header and follows its offset:

```html
<sticky-content>
	<nav class="section-tabs">…</nav>
</sticky-content>
```

By default it rests at `--header-group-height` (directly under the header). Override with the `top` attribute:

```html
<sticky-content top="calc(var(--header-group-height, 0px) + 1rem)">…</sticky-content>
```

Or set `--sticky-content-top` yourself, inline or from a stylesheet — the attribute is only sugar for the inline form, and it owns nothing it did not write. Use one or the other: with both, the attribute wins while it is there and puts your inline value back if it is removed.

```html
<sticky-content style="--sticky-content-top: 6rem">…</sticky-content>
```

Its sticky inset **moves** — `top` is a `calc()` of the resting inset plus the live header offset — so the pin position is continuous at every scroll position. A rider that first pins while the header is already hidden arrives in the right place with no jump.

`<sticky-content>` works with no `<sticky-header>` on the page; it degrades to a plain sticky element that still gets `[stuck]`.

### Keeping the header put while the pointer is on it

Add `hover-lock` and the header stops hiding while the pointer is anywhere inside the group — useful when the header holds a dropdown or mega menu that the user is scrolling within:

```html
<sticky-header hover-lock lock="dropdown-trigger[aria-expanded='true']">…</sticky-header>
```

Anything rendered inside the header is covered automatically, open panels included, because they are DOM children of the host.

It is gated to hover-capable fine pointers (`(hover: hover) and (pointer: fine)`): on touch, `pointerenter` sticks after a tap with no matching `pointerleave`, which would wedge the header open for the rest of the session. On touch devices the attribute is simply inert.

## `<sticky-header>` attributes

| Attribute          | Values                           | Default | Description                                                                                                                                                                                                            |
| ------------------ | -------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hide-on-scroll`   | `none` `mobile` `desktop` `both` | `both`  | Which viewports hide on scroll. Height variables are maintained in every mode                                                                                                                                          |
| `breakpoint`       | px number                        | `1024`  | The desktop cutoff. `desktop` matches `(min-width: bp)`; `mobile` is everything narrower                                                                                                                               |
| `reveal-threshold` | px                               | `100`   | Within this distance of the page top the header is always fully visible                                                                                                                                                |
| `settle-threshold` | `0`–`1`                          | `0.5`   | How far into the gap between the two adjacent stops an idle settle commits to the hidden one rather than back to the reveal stop (with nothing tagged, that gap is the whole travel and the other stop is fully shown) |
| `settle-duration`  | ms                               | `900`   | Hide settle duration; the show settle uses 85% of it                                                                                                                                                                   |
| `settle-overshoot` | `0`–`0.2`                        | `0.05`  | Bounce amplitude. `0` swaps to a critically damped curve — no bounce                                                                                                                                                   |
| `tracking-smoothing` | ms                             | `0`     | Softens the tracking only. A time constant easing the published offset toward the 1:1 value while you scroll; `0` is off and exactly 1:1. See [Tracking smoothing](#tracking-smoothing)                                |
| `hover-lock`       | boolean                          | —       | While the pointer is anywhere in the header group, don't hide on scroll                                                                                                                                                |
| `lock`             | CSS selector                     | —       | Extra force-show condition, e.g. an open menu panel. `dialog[open]` is built in                                                                                                                                        |
| `locked`           | boolean                          | —       | Force fully visible                                                                                                                                                                                                    |
| `disabled`         | boolean                          | —       | Turn tracking off entirely (height variables are still maintained)                                                                                                                                                     |

## Descendant attributes

| Attribute            | Values                             | Description                                                                                                                                                                                      |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `data-sticky-reveal` | `both` `mobile` `desktop`, or bare | On any descendant: this comes back on a mid-page scroll up. The topmost active one is the boundary — see [Multiple bars & scroll-up reveal](#multiple-bars--scroll-up-reveal). Wrapped mode only |
| `data-announcement`  | —                                  | Reports this child's height separately as `--announcement-bar-height`                                                                                                                            |

## `<sticky-content>` attributes

| Attribute  | Description                                                                                                                                                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `top`      | Resting sticky inset — any CSS length. Sugar for setting `--sticky-content-top` inline. Setting that property yourself works just as well; the attribute only owns the inline declaration it writes, and restores yours if it is removed |
| `disabled` | Stop riding the header; pin at the static resting inset instead. `stuck` is no longer applied                                                                                                                                            |

## Custom properties

Written on `<body>` and maintained at every breakpoint, in every mode:

| Property                    | Description                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `--header-group-height`     | Total height of the sliding group                                                                      |
| `--header-height`           | The header alone, without the announcement bar                                                         |
| `--announcement-bar-height` | The `data-announcement` child, when there is one                                                       |
| `--header-group-offset`     | **The rider hook.** Per frame, `0` → −(group height); briefly a little past `0` during the show bounce |
| `--header-reveal-offset`    | The middle stop — −(distance from the group top to the reveal boundary). `0px` with nothing tagged     |

Set by you:

| Property                   | Description                                               |
| -------------------------- | --------------------------------------------------------- |
| `--sticky-content-top`     | A rider's resting inset (default `--header-group-height`) |
| `--sticky-header-z-index`  | Header stacking order (default `100`)                     |
| `--sticky-content-z-index` | Rider stacking order (default `10`)                       |

Any element can ride the header by reading the offset itself:

```css
.my-sticky-thing {
	position: sticky;
	top: calc(var(--header-group-height, 0px) + var(--header-group-offset, 0px));
}
```

Prefer the `top`-based form above over a `transform`. Transforming an element and gating that on a stuck class is what causes an element to jump by the whole offset when it first pins while the header is hidden — the problem `<sticky-content>` exists to avoid.

## State attributes

| Attribute                     | On                 | When                                                          |
| ----------------------------- | ------------------ | ------------------------------------------------------------- |
| `data-state="top\|scrolling"` | `<body>`           | Within 8px of the page top, or not                            |
| `data-header-hidden`          | `<body>`           | Settled fully hidden — never mid-transition                   |
| `data-header-revealed`        | `<body>`           | Settled at the reveal stop, with a boundary inside the group  |
| `data-header-tracking`        | `<body>`           | Tracking or settling. Use it to suppress your own transitions |
| `data-header-locked`          | `<body>`           | A lock condition is holding the header visible                |
| `data-hidden` `data-tracking` | `<sticky-header>`  | Element-level mirrors of the above                            |
| `stuck`                       | `<sticky-content>` | The rider is pinned at its effective top — a styling hook     |

## Events

All bubble, all dispatched on `<sticky-header>`.

| Event                  | When                                                                                                                  | `detail`                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `sticky-header:settle` | A settle tween starts                                                                                                 | `{ target: 'show'\|'hide', from, duration }`        |
| `sticky-header:hide`   | Settled fully hidden                                                                                                  | —                                                   |
| `sticky-header:show`   | Settled anywhere short of fully hidden — including at a partial reveal stop, which fires `show` and `reveal` together | —                                                   |
| `sticky-header:reveal` | Settled at the reveal stop                                                                                            | —                                                   |
| `sticky-header:resize` | Measured geometry changed                                                                                             | `{ headerHeight, announcementHeight, groupHeight }` |

There are deliberately **no per-frame events**. For frame-accurate work read the `offset` / `progress` properties from your own rAF loop, or read the CSS variable.

Internally the whole package runs on one scroll-signal layer: a single set of window listeners and a single rAF loop that terminates itself the moment nothing is moving. A page sitting still costs no frames at all.

## Properties and methods

| Member                | Description                                                                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `offset`              | Current offset in px (`0` shown → −groupHeight hidden)                                                                                                                        |
| `progress`            | Hidden fraction over the full travel, `0` → `1`                                                                                                                               |
| `revealOffset`        | The reveal stop in px — **negative**, on the same axis as `offset` (`0` with nothing tagged)                                                                                  |
| `isHidden`            | Whether it is settled fully hidden (named to avoid shadowing native `HTMLElement.hidden`)                                                                                     |
| `groupHeight`         | Measured height of the sliding group                                                                                                                                          |
| `show()`              | Play the show settle. Resting rules resume when it lands — mid-page on a tagged stack the next idle tucks to the reveal stop, so use `lock()` to hold the group fully visible |
| `hide()`              | Settle fully hidden (ignored while locked or inactive)                                                                                                                        |
| `lock()` / `unlock()` | Toggle the `locked` attribute                                                                                                                                                 |
| `refresh()`           | Re-measure geometry and rebase scroll tracking                                                                                                                                |

`<sticky-content>` exposes two getters: `stuck` (whether it is pinned at its effective top) and `top` (its resting inset in px, excluding the header offset).

Only one `<sticky-header>` can be active per page — the engine writes a single global offset. A second instance warns and stays completely inert: it stamps nothing, observes nothing, and its removal tears nothing down.

The easing factory is exported too, if you want to drive your own animation with the same curve:

```js
import { makeSettleEase } from '@magic-spells/sticky-header';

const ease = makeSettleEase(0.05); // returns (t: 0→1) => number, exact at both ends
```

## Motion

The settle is the step response of a damped harmonic oscillator. `settle-overshoot` is inverted into a damping ratio, so the default 5% gives ζ ≈ 0.690 and peaks at about 36% of the way through. If you want your own CSS transitions to match it, the default curve as a `linear()` timing function is exported as `SETTLE_LINEAR_CURVE`:

```css
transition-timing-function: linear(
	0,
	0.1062,
	0.3275,
	0.5628,
	0.7602,
	0.9018,
	0.9893,
	1.0339,
	1.0492,
	1.0473,
	1.0374,
	1.0255,
	1.0148,
	1.0068,
	1.0016,
	0.9988,
	0.9976,
	0.9975,
	0.9979,
	0.9985,
	0.9991,
	0.9995,
	0.9998,
	1
);
```

### Tracking smoothing

Tracking is 1:1 by default — the header moves exactly as far as you scrolled, which is what makes it feel glued to your finger. On a device whose `scrollY` arrives coarsely quantized, though, 1:1 faithfully reproduces that coarseness as a slightly steppy header.

`tracking-smoothing` is the dial for that. It takes a time constant in milliseconds and eases the _published_ offset toward the 1:1 value while you scroll:

```html
<sticky-header tracking-smoothing="35">…</sticky-header>
```

Roughly, 20ms takes the edge off, 35ms is visibly softer, and past about 50ms the header starts to feel like it is lagging behind your finger rather than following it. The default `0` turns it off completely and restores exact 1:1.

It is deliberately narrow — smoothing applies **only** while tracking, and only to the number written to `--header-group-offset`:

- Settles are never smoothed. They are already a tween, and easing an ease twice is what makes motion feel mushy.
- Every resting stop is still landed on **exactly**. The published value snaps to the real one at rest, so nothing parks a fraction of a pixel short.
- Thresholds, the commit decision and the reveal boundary all still run on the true 1:1 offset, so smoothing changes how the header looks, never where it decides to stop.

Leave it off unless you are looking at a specific device that needs it.

`prefers-reduced-motion: reduce` drops tracking and tweening entirely: the offset flips between whichever two stops currently apply past a 5px direction change, like a classic two-state header. Where `hide-on-scroll` is off and a reveal boundary exists the motion is already a direct position mapping, so it is unchanged.

## On mobile

Mobile browsers make scroll harder than it looks, and the component's scroll signal is normalized for it internally — there is nothing to configure here, but it is worth knowing what it handles:

- **The URL bar and the soft keyboard don't freeze tracking.** Both fire `resize` with only the height changed. Your scroll position is still genuinely yours across one of those, so the header keeps tracking normally through it. (This is a deliberate correction: quieting height-only resizes was the obvious first implementation, and on a real iPhone it backfired badly — iOS toggles the URL bar on nearly every change of scroll direction, so every reversal threw away real movement and stalled the header for the best part of a hundred pixels.)
- **Rotation and real resizes re-anchor instead.** When the _width_ changes, layout has genuinely moved and any movement measured across it is meaningless, so the position is re-adopted with no delta rather than consumed as a gesture.
- **Rubber-band scrolling can't corrupt the geometry.** Position is clamped to the real scrollable range, so over-scrolling at either end never feeds a negative or over-run position into the maths.
- **Momentum flicks settle only once they have actually stopped.** Rest is detected from movement rather than from scroll events, which stop firing well before an iOS flick finishes gliding.
- **Returning to a backgrounded tab doesn't teleport the header.** The first frame back is capped so a multi-minute gap can't become one enormous animation step.

## Gotchas

**Put the background on `<sticky-header>` itself.** The show settle overshoots past rest, which briefly pushes the group down and would open a gap above it. A `::before` cap extends the host's own background 2rem upward to cover that dip, via `background: inherit` — so the background belongs on the host rather than on an inner `<header>`. If yours lives on an inner element, restate it:

```css
sticky-header::before {
	background: var(--my-header-background);
}
```

Transparent headers have nothing to expose, so they need nothing. Setting `settle-overshoot="0"` also removes the dip entirely.

**`position: fixed` descendants.** A transformed ancestor becomes the containing block for its fixed descendants, so a fixed overlay inside the header will be dragged along by the translate. Because JS only ever writes a variable, you can move the translate off the host onto an inner element that is a _sibling_ of the overlay:

```css
sticky-header {
	transform: none;
}
sticky-header > .header-inner {
	transform: translateY(var(--header-group-offset, 0px));
}
```

The component detects this: it checks whether the host resolves to `transform: none` and stops assuming the host rect carries the offset, so both its pinned test and its reveal-boundary measurement keep working either way. Nothing else to configure.

**`overflow: hidden` on an ancestor breaks `position: sticky`.** This is a CSS rule, not something the component can work around. If the header never sticks, walk up the ancestors looking for `overflow: hidden` (or `clip`/`auto`) and remove it.

**Anchor links land under the header.** Give scroll targets a matching scroll margin:

```css
:target,
[id] {
	scroll-margin-top: calc(var(--header-group-height, 0px) + 1rem);
}
```

**A long programmatic jump hides the header in one frame.** A `scrollTo` that moves further than the group height is still 1:1 tracking — direction decides, and the whole travel is consumed at once. That is correct behavior, not a bug. To keep the header visible across the jump, `lock()` before it and `unlock()` after — a lock suspends tracking, so nothing retargets the group while it is on. `show()` is not the tool for this: it plays the show settle, and normal resting rules apply again the moment that lands, so on a stack with `data-sticky-reveal` tags the top-only layers tuck to the reveal stop at the next idle.

**One `<sticky-header>` per page.** Extra instances warn and no-op.

## Migrating from a two-state header

If you're coming from a `body[data-header-hidden]` + `transition: transform 0.3s` setup (the classic two-state pattern this package generalizes):

- The variable names are unchanged — `--header-group-height`, `--header-height`, `--announcement-bar-height`, `--header-group-offset`, `body[data-state]` and `body[data-header-hidden]` all mean what they did. Existing CSS that reads them keeps working.
- **Delete the CSS transitions.** `--header-group-offset` is now tweened per frame in JS. A CSS transition on top of it will fight the settle and lag the tracking. The package CSS contains no transitions anywhere for this reason.
- **Delete the `@media (prefers-reduced-motion)` transition overrides.** With no transitions there is nothing to disable; reduced motion is handled in JS.
- `body[data-header-hidden]` now means _settled_ fully hidden, not "the flag JS flipped." Mid-transition it is absent. If you were using it as a general "is scrolling down" signal, use `data-header-tracking` or read `progress`.
- A `.transform-y-header`-style utility still works, but prefer converting those elements to `<sticky-content>` — the moving inset removes the pin-jump that the transform utility has when an element becomes stuck while the header is already hidden.
- `hide-on-scroll="mobile"` with `breakpoint="1024"` reproduces the mobile-only behavior exactly.

## License

MIT

---

<p align="center">
  Made by <a href="https://github.com/coryschulz">Cory Schulz</a>
</p>
