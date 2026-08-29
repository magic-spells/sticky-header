/*
  Viewport metrics and the signal layer's export surface.

  jsdom has no `CSS.supports`, so the probe never gets built here and both
  heights fall back to the live viewport — which is exactly the path a browser
  without `100svh` takes, and the one worth pinning down.

  The `exports` block below is the extraction contract: the signal layer's
  module boundary is deliberately kept stable, so these names and constant
  values are what a second consumer would get if it were ever pulled back out
  into its own package. It reads the two lib modules directly — `src/index.js`
  is the COMPONENT entry here (it imports CSS and registers custom elements),
  not the signal layer's surface.
*/

import { afterEach, describe, expect, it } from 'vitest';
import * as api from '../src/lib/scroll-handler.js';
import { ViewportMetrics } from '../src/lib/viewport-metrics.js';
import { createEnv, record } from './harness.js';

let env = null;

afterEach(() => {
	env?.teardown();
	env = null;
});

describe('ViewportMetrics', () => {
	it('falls back to the live viewport height with no probe', () => {
		env = createEnv({ innerHeight: 640 });
		const metrics = ViewportMetrics.refresh();
		expect(metrics.currentHeight).toBe(640);
		expect(metrics.stableHeight).toBe(640);
	});

	it('re-reads on every refresh', () => {
		env = createEnv({ innerHeight: 640 });
		ViewportMetrics.refresh();
		window.innerHeight = 900;
		expect(ViewportMetrics.refresh().currentHeight).toBe(900);
	});

	it('reaches subscribers through the resize callback', () => {
		env = createEnv({ innerHeight: 800 });
		const seen = record();

		env.resize({ height: 500 });

		expect(seen.resizes).toEqual([{ currentHeight: 500, stableHeight: 500 }]);
		seen.sub.unsubscribe();
	});
});

describe('exports', () => {
	it('exposes the documented surface', () => {
		expect(typeof api.ScrollHandler.subscribe).toBe('function');
		expect(typeof api.ScrollHandler.rebase).toBe('function');
		expect(typeof api.ScrollHandler.quiet).toBe('function');
		expect(typeof api.expApproach).toBe('function');
		expect(typeof ViewportMetrics.refresh).toBe('function');
		expect(api.IDLE_MS).toBe(120);
		expect(api.RESIZE_QUIET_MS).toBe(100);
		expect(api.MAX_FRAME_DELTA).toBe(64);
		expect(api.MAX_VELOCITY).toBe(100);
		expect(api.VELOCITY_THRESHOLD).toBe(0.01);
	});

	it('attaches nothing at import time', () => {
		// the module is imported at the top of this file; if importing bound a
		// listener or started a loop, this would already be true
		expect(api.ScrollHandler._listening).toBe(false);
		expect(api.ScrollHandler._subs.length).toBe(0);
	});
});
