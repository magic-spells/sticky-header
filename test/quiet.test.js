/*
  Quiet windows, resize classification and rebase.

  A quiet window is how the handler survives mobile chrome: the URL bar
  collapsing fires resize AND a burst of phantom scroll deltas, and consuming
  those as gestures is how a sticky header ends up half-hidden for no reason.
  Deltas inside the window are reported as exactly 0, with `packet.quiet` true
  so a consumer can tell the difference between "nothing moved" and "we are not
  telling you what moved".
*/

import { afterEach, describe, expect, it } from 'vitest';
import { ScrollHandler, RESIZE_QUIET_MS } from '../src/lib/scroll-handler.js';
import { createEnv, record } from './harness.js';

let env = null;

afterEach(() => {
	env?.teardown();
	env = null;
});

describe('quiet windows', () => {
	it('zeroes deltas inside the window and reports them live outside it', () => {
		env = createEnv();
		const seen = record({ keepAwake: true });

		env.frame();
		ScrollHandler.quiet();

		env.setScrollY(300);
		env.frame();
		expect(seen.last.quiet).toBe(true);
		expect(seen.last.delta).toBe(0);
		expect(seen.last.y).toBe(300); // the POSITION is still true, only the delta is held

		// step past the end of the window, then move again
		env.advance(RESIZE_QUIET_MS);
		env.setScrollY(360);
		env.frame();
		expect(seen.last.quiet).toBe(false);
		expect(seen.last.delta).toBe(60);

		seen.sub.unsubscribe();
	});

	it('holds scroll-event deltas out of the velocity EMA too', () => {
		env = createEnv();
		const seen = record({ keepAwake: true });

		ScrollHandler.quiet();
		env.scrollTo(500);

		expect(ScrollHandler.velocity).toBe(0);
		seen.sub.unsubscribe();
	});
});

describe('resize classification', () => {
	it('treats a width change as a real resize: quiet window plus a rebase', () => {
		env = createEnv({ innerWidth: 1200 });
		const seen = record({ keepAwake: true });
		env.frame();

		env.resize({ width: 800 });

		expect(seen.rebases).toEqual(['resize']);
		expect(seen.resizes.length).toBe(1);

		env.setScrollY(200);
		env.frame();
		expect(seen.last.quiet).toBe(true);
		expect(seen.last.delta).toBe(0);

		seen.sub.unsubscribe();
	});

	it('never quiets a height-only resize, and still delivers the metrics', () => {
		// fixed behavior, not an option: iOS toggles the URL bar on every scroll
		// direction reversal, so quieting these froze tracking for ~70-100px per
		// reversal — worse than the phantom deltas it was swallowing
		env = createEnv({ innerHeight: 800 });
		const seen = record({ keepAwake: true });
		env.frame();

		env.resize({ height: 700 });

		// no quiet, no rebase — but the metrics still go out, because a consumer
		// resolving ranges against the viewport still has to re-resolve them
		expect(seen.rebases).toEqual([]);
		expect(seen.resizes.length).toBe(1);
		expect(seen.resizes[0]).toHaveProperty('currentHeight');
		expect(seen.resizes[0]).toHaveProperty('stableHeight');

		env.setScrollY(200);
		env.frame();
		expect(seen.last.quiet).toBe(false);
		expect(seen.last.delta).toBe(200);

		seen.sub.unsubscribe();
	});

	it('always quiets a width change, whatever the height did', () => {
		// rotation and real resizes always quiet and rebase — the one branch
		// that survives, and it is unconditional
		env = createEnv({ innerWidth: 1200 });
		const seen = record({ keepAwake: true });
		env.frame();

		env.resize({ width: 900 });

		expect(seen.rebases).toEqual(['resize']);
		seen.sub.unsubscribe();
	});
});

describe('rebase', () => {
	it('adopts the current position with no delta on the next frame', () => {
		env = createEnv();
		const seen = record({ keepAwake: true });
		env.frame();

		env.setScrollY(500);
		ScrollHandler.rebase();
		env.frame();

		expect(seen.rebases).toEqual(['manual']);
		expect(seen.last.y).toBe(500);
		expect(seen.last.delta).toBe(0);

		seen.sub.unsubscribe();
	});

	it('re-anchors the velocity EMA as well, so the jump is not a gesture', () => {
		env = createEnv();
		const seen = record({ keepAwake: true });
		env.frame();

		env.setScrollY(2000);
		ScrollHandler.rebase();
		env.scrollTo(2000);

		expect(ScrollHandler.velocity).toBe(0);
		seen.sub.unsubscribe();
	});

	it('adopts a restored scroll position instead of treating it as a gesture', () => {
		// a handler started before `load` has to assume the next scroll is the
		// browser restoring a position, not the user moving
		env = createEnv({ readyState: 'loading' });
		const seen = record({ keepAwake: true });
		env.frame();

		env.scrollTo(1200);
		env.frame();

		expect(seen.rebases).toEqual(['restore']);
		expect(seen.last.y).toBe(1200);
		expect(seen.last.delta).toBe(0);

		seen.sub.unsubscribe();
	});

	it('does not arm restore adoption once the document is complete', () => {
		// otherwise the flag is never cleared for a late start (an SPA route, a
		// lazy import) and the first real gesture gets eaten
		env = createEnv({ readyState: 'complete' });
		const seen = record({ keepAwake: true });
		env.frame();

		env.scrollTo(120);
		env.frame();

		expect(seen.rebases).toEqual([]);
		expect(seen.last.delta).toBe(120);

		seen.sub.unsubscribe();
	});

	it('adopts the position on load and on pageshow', () => {
		env = createEnv();
		const seen = record({ keepAwake: true });
		env.frame();

		env.setScrollY(900);
		env.fireWindow('load');
		env.frame();
		expect(seen.rebases).toEqual(['restore']);
		expect(seen.last.delta).toBe(0);

		env.setScrollY(1500);
		env.fireWindow('pageshow');
		env.frame();
		expect(seen.rebases).toEqual(['restore', 'restore']);
		expect(seen.last.delta).toBe(0);

		seen.sub.unsubscribe();
	});
});
