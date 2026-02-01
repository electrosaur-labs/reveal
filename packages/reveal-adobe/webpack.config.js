const path = require('path');
const webpack = require('webpack');
const crypto = require('crypto');

module.exports = (env, argv) => {
    const mode = argv.mode || 'development';
    const isProduction = mode === 'production';
    const isTest = env && env.test;  // Enable test mode with --env test

    // Generate unique build ID on every build
    const buildId = crypto.randomUUID();
    const buildTime = new Date().toISOString();

    console.log('==========================================');
    console.log('Building Reveal Plugin');
    console.log(`Build ID: ${buildId}`);
    console.log(`Build Time: ${buildTime}`);
    console.log(`Test Mode: ${isTest ? 'ENABLED' : 'DISABLED'}`);
    console.log('==========================================');

    return {
        mode: mode,
        entry: './src/index.js',
        output: {
            path: path.resolve(__dirname, 'dist'),
            filename: 'index.js',
            clean: false
        },
        module: {
            rules: []
        },
        plugins: [
            new webpack.DefinePlugin({
                '__BUILD_ID__': JSON.stringify(buildId),
                '__BUILD_TIME__': JSON.stringify(buildTime),
                '__TEST_MODE__': isTest  // Boolean, not JSON string
            }),
            // Provide Buffer polyfill for libraries that need it (like jpeg-js)
            new webpack.ProvidePlugin({
                Buffer: ['buffer', 'Buffer']
            })
        ],
        resolve: {
            extensions: ['.js', '.json'],
            alias: {
                '@': path.resolve(__dirname, 'src'),
                '@core': path.resolve(__dirname, 'src/core'),
                '@api': path.resolve(__dirname, 'src/api'),
                '@utils': path.resolve(__dirname, 'src/utils'),
                '@palettes': path.resolve(__dirname, 'src/palettes'),
                '@data': path.resolve(__dirname, 'src/data')
            },
            fallback: {
                // Provide buffer polyfill for browser-like environments (UXP)
                buffer: require.resolve('buffer/'),
                // Explicitly disable Node.js core modules (UXP doesn't have them)
                fs: false,
                path: false
            }
        },
        externals: {
            photoshop: 'commonjs2 photoshop',
            uxp: 'commonjs2 uxp'
        },
        target: 'web',
        devtool: isProduction ? false : 'source-map',
        optimization: {
            minimize: isProduction
        }
    };
};
