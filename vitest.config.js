export default {
	test: {
		// jsdom gives the module a real window/document to bind listeners to.
		// Everything time- or geometry-related is stubbed by test/harness.js —
		// no test depends on a real clock, a real rAF, or a real layout.
		environment: 'jsdom',
		include: ['test/**/*.test.js'],
		restoreMocks: true,
	},
};
