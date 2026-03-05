/**
 * Minimal event emitter for Navigator UI reactivity.
 */
const logger = require('@electrosaur-labs/core').logger;

class EventEmitter {
    constructor() {
        this._listeners = Object.create(null);
    }

    /**
     * Register a listener for an event.
     * @param {string} event
     * @param {Function} callback
     */
    on(event, callback) {
        if (!this._listeners[event]) {
            this._listeners[event] = [];
        }
        this._listeners[event].push(callback);
    }

    /**
     * Remove a listener for an event.
     * @param {string} event
     * @param {Function} callback
     */
    off(event, callback) {
        const list = this._listeners[event];
        if (!list) return;
        this._listeners[event] = list.filter(cb => cb !== callback);
    }

    /**
     * Emit an event with optional data payload.
     * @param {string} event
     * @param {*} data
     */
    emit(event, data) {
        const list = this._listeners[event];
        if (!list) return;
        for (let i = 0; i < list.length; i++) {
            try {
                list[i](data);
            } catch (err) {
                logger.log(`[EventEmitter] Error in "${event}" listener:`, err);
            }
        }
    }
}

module.exports = EventEmitter;
