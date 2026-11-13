/**
 * CreditsController.js
 * Controls the dedicated theatrical credits window in Reveal Navigator.
 *
 * Features:
 * - Native scrollbars active from the get-go for unhurried browsing
 * - Gentle auto-crawl that yields immediately to manual user scrolling or hover
 * - Closes on Esc key or clicking the backdrop
 * - Easter Egg: Dedicated Silk-Screen Broadside Viewer for Doug Minkler's Manifesto
 * - UXP-safe layout (pure flexbox, zero floats)
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

        // Easter Egg: Minkler Manifesto Broadside
        this.emblem = this.overlay.querySelector('#credits-emblem');
        this.printTrigger = this.overlay.querySelector('#credits-print-trigger');
        this.broadside = this.overlay.querySelector('#manifesto-broadside');

        this.speed = 24; // pixels per second gentle ambient crawl
        this.isPlaying = false;
        this.isHovered = false;
        this.isManifestoOpen = false;
        this.userHasScrolled = false;
        this.lastTimestamp = 0;
        this.rafId = null;

        this._tick = this._tick.bind(this);
        this._handleKeyDown = this._handleKeyDown.bind(this);
        this._bindEvents();
    }

    _bindEvents() {
        // Clicking backdrop outside the credits window dismisses the overlay
        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) {
                this.close();
            }
        });

        if (this.viewport) {
            const onEnter = () => { this.isHovered = true; };
            const onLeave = () => { this.isHovered = false; };
            this.viewport.addEventListener('mouseenter', onEnter);
            this.viewport.addEventListener('mouseleave', onLeave);
            this.viewport.addEventListener('pointerenter', onEnter);
            this.viewport.addEventListener('pointerleave', onLeave);
            this.viewport.addEventListener('mouseover', onEnter);
            this.viewport.addEventListener('mouseout', onLeave);

            // Once the user interacts with the scrollbar, pause ambient crawl
            this.viewport.addEventListener('wheel', () => {
                this.pause();
                this.userHasScrolled = true;
            });
            this.viewport.addEventListener('pointerdown', () => {
                this.pause();
            });
        }

        // Easter egg triggers: pause crawl immediately on pointerdown, and open manifesto on genuine click
        const onTriggerDown = () => {
            this.pause();
        };

        const triggerManifesto = (e) => {
            if (e) {
                e.preventDefault();
                e.stopPropagation();
            }
            this.openManifesto();
        };

        if (this.emblem) {
            this.emblem.addEventListener('pointerdown', onTriggerDown);
            this.emblem.addEventListener('click', triggerManifesto);
        }
        if (this.printTrigger) {
            this.printTrigger.addEventListener('pointerdown', onTriggerDown);
            this.printTrigger.addEventListener('click', triggerManifesto);
        }

        // Bind Escape key on broadside, window, and document so Esc on manifesto or credits always closes plugin
        if (this.broadside) {
            this.broadside.addEventListener('keydown', this._handleKeyDown);
        }
        if (typeof window !== 'undefined') {
            window.addEventListener('keydown', this._handleKeyDown);
        }
        if (typeof document !== 'undefined') {
            document.addEventListener('keydown', this._handleKeyDown);
        }
    }

    _handleKeyDown(e) {
        if (e.key === 'Escape' || e.key === 'Esc') {
            if (this.overlay && this.overlay.style.display !== 'none') {
                this.close();
                if (typeof document !== 'undefined') {
                    const dialog = document.getElementById('navigatorDialog');
                    if (dialog && typeof dialog.close === 'function') {
                        try {
                            dialog.close('cancel');
                        } catch (err) {}
                    }
                }
            }
        }
    }

    open() {
        if (!this.overlay) return;
        this.closeManifesto();
        this.overlay.style.display = 'flex';
        this.userHasScrolled = false;
        if (this.viewport) {
            this.viewport.scrollTop = 0;
        }
        this.play();
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
        try {
            this.broadside.focus();
        } catch (_) {}
    }

    closeManifesto() {
        if (!this.broadside) return;
        this.isManifestoOpen = false;
        this.broadside.style.display = 'none';
        if (this.overlay && this.overlay.style.display !== 'none' && !this.userHasScrolled) {
            this.play();
        }
    }

    play() {
        if (this.isManifestoOpen || this.userHasScrolled) return;
        this.isPlaying = true;
        this.lastTimestamp = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (!this.rafId && typeof requestAnimationFrame !== 'undefined') {
            this.rafId = requestAnimationFrame(this._tick);
        }
    }

    pause() {
        this.isPlaying = false;
        if (this.rafId && typeof cancelAnimationFrame !== 'undefined') {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }

    _tick(timestamp) {
        if (!this.isPlaying || this.isManifestoOpen || this.userHasScrolled) return;

        const ts = timestamp || (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const delta = Math.min((ts - this.lastTimestamp) / 1000, 0.1);
        this.lastTimestamp = ts;

        if (!this.isHovered && this.viewport) {
            const maxScroll = this.viewport.scrollHeight - this.viewport.clientHeight;
            if (this.viewport.scrollTop < maxScroll - 2) {
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
