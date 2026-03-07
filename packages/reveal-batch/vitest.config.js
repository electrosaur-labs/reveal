const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
    test: {
        globals: true,
        testTimeout: 60_000
    }
});
