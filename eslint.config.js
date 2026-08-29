import globals from 'globals';
import pluginJs from '@eslint/js';

/** @type {import('eslint').Linter.Config[]} */
export default [
	{
		ignores: ['dist/', 'demo/dist/', 'node_modules/'],
	},
	{
		// Source files
		files: ['src/**/*.js'],
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.es2024,
			},
			ecmaVersion: 2024,
			sourceType: 'module',
		},
		...pluginJs.configs.recommended,
	},
	{
		// Test suite — jsdom, so browser globals, plus node for the vitest runner
		files: ['test/**/*.js', 'vitest.config.js'],
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node,
				...globals.es2024,
			},
			ecmaVersion: 2024,
			sourceType: 'module',
		},
		...pluginJs.configs.recommended,
	},
	{
		// Build scripts
		files: ['scripts/**/*.{js,mjs}'],
		languageOptions: {
			globals: {
				...globals.node,
				...globals.es2024,
			},
			ecmaVersion: 2024,
			sourceType: 'module',
		},
	},
];
