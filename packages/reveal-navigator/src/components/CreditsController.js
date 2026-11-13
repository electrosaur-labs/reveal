/**
 * CreditsController.js
 * Controls the cinematic Hollywood-style scrolling credits window in Reveal Navigator.
 *
 * Features:
 * - Smooth vertical crawl (~28 px/sec) using requestAnimationFrame
 * - Hover-to-pause so users can read cards without rushing
 * - Interactive playback bar: Play/Pause toggle, Replay (reset to top), and Close
 * - Easter Egg: Clicking the Doug Minkler dedication header or mascot reveals the
 *   full-bleed serigraph Manifesto Broadside ("Reduction is Revelation")
 * - Keyboard navigation: Esc closes manifesto or credits overlay
 */

class CreditsController {
    /**
     * @param {HTMLElement} overlayEl - The #credits-overlay container
     */
    constructor(overlayEl) {
        this.overlay = overlayEl;
        if (!this.overlay) return;

        this.viewport = this.overlay.querySelector('#credits-viewport');
        this.crawl = this.overlay.querySelector('#credits-crawl');
        this.btnClose = this.overlay.querySelector('#btn-credits-close');
        this.btnPlayPause = this.overlay.querySelector('#btn-credits-playpause');
        this.btnReplay = this.overlay.querySelector('#btn-credits-replay');

        // Easter Egg: Minkler Manifesto Broadside
        this.emblem = this.overlay.querySelector('#credits-emblem');
        this.broadside = this.overlay.querySelector('#manifesto-broadside');
        this.btnManifestoClose = this.overlay.querySelector('#btn-manifesto-close');

        this.speed = 28; // pixels per second
        this.isPlaying = false;
        this.isHovered = false;
        this.isManifestoOpen = false;
        this.lastTimestamp = 0;
        this.rafId = null;

        this._tick = this._tick.bind(this);
        this._handleKeyDown = this._handleKeyDown.bind(this);
        this._bindEvents();
    }

    _bindEvents() {
        if (this.btnClose) {
            this.btnClose.addEventListener('click', () => this.close());
        }
        if (this.btnPlayPause) {
            this.btnPlayPause.addEventListener('click', () => {
                this.togglePlayPause();
            });
        }
        if (this.btnReplay) {
            this.btnReplay.addEventListener('click', () => {
                this.replay();
            });
        }
        if (this.viewport) {
            this.viewport.addEventListener('mouseenter', () => {
                this.isHovered = true;
            });
            this.viewport.addEventListener('mouseleave', () => {
                this.isHovered = false;
            });
        }

        // Easter egg trigger & dismiss
        if (this.emblem) {
            this.emblem.addEventListener('click', () => {
                this.openManifesto();
            });
        }
        if (this.btnManifestoClose) {
            this.btnManifestoClose.addEventListener('click', (e) => {
                e.stopPropagation();
                this.closeManifesto();
            });
        }
        if (this.broadside) {
            this.broadside.addEventListener('click', (e) => {
                if (e.target === this.broadside) {
                    this.closeManifesto();
                }
            });
        }

        // Global keydown for Escape
        if (typeof window !== 'undefined') {
            window.addEventListener('keydown', this._handleKeyDown);
        }
    }

    _handleKeyDown(e) {
        if (e.key === 'Escape' || e.key === 'Esc') {
            if (this.isManifestoOpen) {
                this.closeManifesto();
                e.stopPropagation();
            } else if (this.overlay && this.overlay.style.display !== 'none') {
                this.close();
                e.stopPropagation();
            }
        }
    }

    open() {
        if (!this.overlay) return;
        this.closeManifesto();
        this.overlay.style.display = 'flex';
        this.replay();
    }

    close() {
        if (!this.overlay) return;
        this.closeManifesto();
        this.pause();
        this.overlay.style.display = 'none';
    }

    openManifesto() {
        if (!this.broadside) return;
        this.isManifestoOpen = true;
        this.pause();
        this.broadside.style.display = 'flex';
    }

    closeManifesto() {
        if (!this.broadside) return;
        this.isManifestoOpen = false;
        this.broadside.style.display = 'none';
        if (this.overlay && this.overlay.style.display !== 'none') {
            this.play();
        }
    }

    togglePlayPause() {
        if (this.isPlaying) {
            this.pause();
        } else {
            this.play();
        }
    }

    play() {
        if (this.isManifestoOpen) return;
        this.isPlaying = true;
        this.lastTimestamp = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (this.btnPlayPause) {
            this.btnPlayPause.textContent = '⏸ Pause';
        }
        if (!this.rafId && typeof requestAnimationFrame !== 'undefined') {
            this.rafId = requestAnimationFrame(this._tick);
        }
    }

    pause() {
        this.isPlaying = false;
        if (this.btnPlayPause) {
            this.btnPlayPause.textContent = '▶ Play';
        }
        if (this.rafId && typeof cancelAnimationFrame !== 'undefined') {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }

    replay() {
        if (this.viewport) {
            this.viewport.scrollTop = 0;
        }
        this.play();
    }

    _tick(timestamp) {
        if (!this.isPlaying || this.isManifestoOpen) return;

        const ts = timestamp || (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const delta = Math.min((ts - this.lastTimestamp) / 1000, 0.1);
        this.lastTimestamp = ts;

        if (!this.isHovered && this.viewport) {
            const maxScroll = this.viewport.scrollHeight - this.viewport.clientHeight;
            if (this.viewport.scrollTop < maxScroll) {
                this.viewport.scrollTop += this.speed * delta;
            } else {
                this.pause();
                return;
            }
        }

        if (this.isPlaying && typeof requestAnimationFrame !== 'undefined') {
            this.rafId = requestAnimationFrame(this._tick);
        }
    }
}

module.exports = CreditsController;
