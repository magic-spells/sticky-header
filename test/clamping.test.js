/*
  Position clamping and the lazy maxScrollY cache.

  `y` is the number consumers do geometry with, so it never leaves
  [0, maxScrollY] — iOS rubber-band at either end would otherwise put a
  negative or over-run position into everybody's math at once. `rawY` is kept
  alongside it for anything that genuinely wants the over-scroll.

  `maxScrollY` costs a `scrollHeight` read, which forces layout, so it is
  cached and refreshed only where it can have gone stale.
*/

import { afterEach, describe, expect, it } from 'vitest';
import { ScrollHandler } from '../src/lib/scroll-handler.js';
import { createEnv, record } from './harness.js';

let env = null;

afterEach(() => {
	env?.teardown();
	env = null;
});

describe('clamping', () => {
	it('pins y at 0 through a top rubber-band and keeps rawY negative', () => {
		env = createEnv({ scrollHeight: 4000, innerHeight: 800 });
		const seen = record();

		env.setScrollY(-40);
		env.frame();

		expect(seen.last.y).toBe(0);
		expect(seen.last.rawY).toBe(-40);
		seen.sub.unsubscribe();
	});

	it('pins y at maxScrollY through a bottom rubber-band', () => {
		env = createEnv({ scrollHeight: 4000, innerHeight: 800 });
		const seen = record();
		expect(ScrollHandler.maxScrollY).toBe(3200);

		env.setScrollY(3400);
		env.frame();

		expect(seen.last.y).toBe(3200);
		expect(seen.last.rawY).toBe(3400);
		seen.sub.unsubscribe();
	});

	it('reports no delta across a rubber-band that never moved the clamped position', () => {
		env = createEnv({ scrollHeight: 4000, innerHeight: 800 });
		const seen = record({ keepAwake: true });

		env.setScrollY(3200);
		env.frame();
		env.setScrollY(3260);
		env.frame();
		env.setScrollY(3320);
		env.frame();

		expect(seen.frames.slice(-2).map((f) => f.delta)).toEqual([0, 0]);
		seen.sub.unsubscribe();
	});
});

describe('the maxScrollY cache', () => {
	it('is refreshed from the frame loop when rawY runs past it', () => {
		env = createEnv({ scrollHeight: 4000, innerHeight: 800 });
		const seen = record();
		expect(ScrollHandler.maxScrollY).toBe(3200);

		// the page grew — an infinite scroll appended, an accordion opened —
		// with no resize and no new gesture to notice it
		env.setScrollHeight(10000);
		expect(ScrollHandler.maxScrollY).toBe(3200);

		env.setScrollY(5000);
		env.frame();

		expect(ScrollHandler.maxScrollY).toBe(9200);
		expect(seen.last.y).toBe(5000);
		seen.sub.unsubscribe();
	});

	it('is refreshed at the start of a gesture, not every frame', () => {
		env = createEnv({ scrollHeight: 4000, innerHeight: 800 });
		const seen = record();

		// a shrinking page cannot be caught by the rawY test — the cache is too
		// LARGE, not too small — so the once-per-gesture refresh is what fixes it
		env.setScrollHeight(2000);
		env.scrollTo(100);

		expect(ScrollHandler.maxScrollY).toBe(1200);
		seen.sub.unsubscribe();
	});

	it('is refreshed on resize', () => {
		env = createEnv({ scrollHeight: 4000, innerHeight: 800 });
		const seen = record();

		env.resize({ height: 400 });

		expect(ScrollHandler.maxScrollY).toBe(3600);
		seen.sub.unsubscribe();
	});

	it('never goes negative on a page shorter than the viewport', () => {
		env = createEnv({ scrollHeight: 300, innerHeight: 800 });
		const seen = record();

		expect(ScrollHandler.maxScrollY).toBe(0);
		env.setScrollY(50);
		env.frame();
		expect(seen.last.y).toBe(0);
		seen.sub.unsubscribe();
	});
});
