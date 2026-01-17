/**
 * Logger Utility
 *
 * Provides timestamped console logging for debugging and diagnostics.
 * Drop-in replacement for console.log/warn/error.
 */

/**
 * Format timestamp as HH:MM:SS.mmm
 */
function getTimestamp() {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    return `${hours}:${minutes}:${seconds}.${ms}`;
}

/**
 * Log with timestamp prefix
 */
function log(...args) {
    console.log(`[${getTimestamp()}]`, ...args);
}

/**
 * Warn with timestamp prefix
 */
function warn(...args) {
    console.warn(`[${getTimestamp()}]`, ...args);
}

/**
 * Error with timestamp prefix
 */
function error(...args) {
    console.error(`[${getTimestamp()}]`, ...args);
}

/**
 * Group with timestamp (for console.group)
 */
function group(...args) {
    console.group(`[${getTimestamp()}]`, ...args);
}

/**
 * Group end
 */
function groupEnd() {
    console.groupEnd();
}

// Export logger interface (CommonJS only for pure Node.js compatibility)
const logger = {
    log,
    warn,
    error,
    group,
    groupEnd
};

module.exports = logger;
