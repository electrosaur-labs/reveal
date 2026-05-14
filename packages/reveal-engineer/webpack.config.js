const path = require('path');
const webpack = require('webpack');
const crypto = require('crypto');

module.exports = (env, argv) => {
    const mode = argv.mode || 'development';
    const isProduction = mode === 'production';

    // Generate unique build ID on every build
    const buildId = crypto.randomUUID();
    const buildTime = new Date().toISOString();

    console.log('==========================================');
    console.log('Building Engineer Plugin');
    console.log(`Build ID: ${buildId}`);
    console.log(`Build Time: ${buildTime}`);
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
                '__BUILD_TIME__': JSON.stringify(buildTime)
            }),
            // Provide Buffer polyfill for libraries that need it (like jpeg-js)
            new webpack.ProvidePlugin({
                Buffer: ['buffer', 'Buffer']
            })
        ],
        resolve: {
            extensions: ['.js', '.json'],
            alias: {
                '@electrosaur-labs/core': path.resolve(__dirname, '../reveal-core'),
                '@electrosaur-labs/adapter': path.resolve(__dirname, 'src/bridge/FrameworkAdapter.js'),
                'reveal-framework': path.resolve(__dirname, '../reveal-core/lib/framework/index.js')
            },
            fallback: {
                // Provide buffer polyfill for browser-like environments (UXP)
                buffer: require.resolve('buffer/'),
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
