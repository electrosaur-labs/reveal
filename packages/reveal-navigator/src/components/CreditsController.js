/**
 * CreditsController.js
 * Controls the cinematic Hollywood-style scrolling credits window in Reveal Navigator.
 *
 * Features:
 * - Smooth vertical crawl (~28 px/sec) using requestAnimationFrame
 * - Hover-to-pause so users can read cards without rushing
 * - Auto-finishes and grays out Play after 1 full round so user can freely scroll
 * - Re-enables Play button if user scrolls back to the top
 * - Easter Egg: Dedicated Silk-Screen Broadside Viewer for Doug Minkler's Manifesto
 * - UXP-safe layout (flexbox-based, zero floats)
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

        // Easter Egg: Minkler Manifesto Broadside
        this.emblem = this.overlay.querySelector('#credits-emblem');
        this.broadside = this.overlay.querySelector('#manifesto-broadside');
        this.btnManifestoClose = this.overlay.querySelector('#btn-manifesto-close');

        this.speed = 28; // pixels per second
        this.isPlaying = false;
        this.isHovered = false;
        this.isManifestoOpen = false;
        this.hasFinishedFirstRound = false;
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
                if (!this.hasFinishedFirstRound) {
                    this.togglePlayPause();
                }
            });
        }
        if (this.viewport) {
            this.viewport.addEventListener('mouseenter', () => {
                this.isHovered = true;
            });
            this.viewport.addEventListener('mouseleave', () => {
                this.isHovered = false;
            });
            this.viewport.addEventListener('scroll', () => {
                // If user scrolled back up near the top after finishing, re-enable Play
                if (this.hasFinishedFirstRound && this.viewport.scrollTop < 50) {
                    this.hasFinishedFirstRound = false;
                    if (this.btnPlayPause) {
                        this.btnPlayPause.disabled = false;
                        this.btnPlayPause.textContent = '▶ Play';
                        this.btnPlayPause.style.opacity = '1';
                        this.btnPlayPause.style.cursor = 'pointer';
                    }
                }
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
        this.restartCrawl();
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
        if (this.overlay && this.overlay.style.display !== 'none' && !this.hasFinishedFirstRound) {
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
        if (this.isManifestoOpen || this.hasFinishedFirstRound) return;
        this.isPlaying = true;
        this.lastTimestamp = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (this.btnPlayPause) {
            this.btnPlayPause.disabled = false;
            this.btnPlayPause.textContent = '⏸ Pause';
            this.btnPlayPause.style.opacity = '1';
            this.btnPlayPause.style.cursor = 'pointer';
        }
        if (!this.rafId && typeof requestAnimationFrame !== 'undefined') {
            this.rafId = requestAnimationFrame(this._tick);
        }
    }

    pause() {
        this.isPlaying = false;
        if (this.btnPlayPause && !this.hasFinishedFirstRound) {
            this.btnPlayPause.textContent = '▶ Play';
        }
        if (this.rafId && typeof cancelAnimationFrame !== 'undefined') {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }

    finishCrawl() {
        this.pause();
        this.hasFinishedFirstRound = true;
        if (this.btnPlayPause) {
            this.btnPlayPause.disabled = true;
            this.btnPlayPause.textContent = '✓ Completed';
            this.btnPlayPause.style.opacity = '0.35';
            this.btnPlayPause.style.cursor = 'default';
        }
    }

    restartCrawl() {
        this.hasFinishedFirstRound = false;
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
            if (this.viewport.scrollTop < maxScroll - 2) {
                this.viewport.scrollTop += this.speed * delta;
            } else {
                // Completed 1 full round: gray out Play button and leave scrollbar active
                this.finishCrawl();
                return;
            }
        }

        if (this.isPlaying && typeof requestAnimationFrame !== 'undefined') {
            this.rafId = requestAnimationFrame(this._tick);
        }
    }
}

module.exports = CreditsController;
