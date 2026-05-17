/**
 * ArchetypeCarousel - Horizontal card strip for dynamic engine navigation
 *
 * For the Engineer UI, this carousel features the 5 Celtic goddess engines.
 * Each card represents a declarative engine definition fused with the
 * image-DNA-matched archetype.
 *
 * Active card shows real palette swatches from proxy separation.
 * Vanilla+ pattern: subscribes to SessionState events.
 */

const Reveal = require("@electrosaur-labs/core");
const EngineRegistry = Reveal.engines.EngineRegistry;
const logger = Reveal.logger;

class ArchetypeCarousel {

    /**
     * @param {HTMLElement} container - DOM element to render cards into
     * @param {import('../state/SessionState')} sessionState
     */
    constructor(container, sessionState) {
        this._container = container;
        this._session = sessionState;
        this._activeId = null;      // Currently active engine ID
        this._hoveredId = null;

        this._sessionListeners = []; // [{event, handler}]

        this._initTooltip();
        this._bindEvents();
    }

    /**
     * Clean up all event listeners and DOM content.
     */
    destroy() {
        // Remove session event listeners
        for (const { event, handler } of this._sessionListeners) {
            this._session.off(event, handler);
        }
        this._sessionListeners = [];

        // Clear card DOM
        this._container.innerHTML = '';
    }

    /**
     * Create a shared tooltip element for description hover.
     */
    _initTooltip() {
        this._tooltipEl = document.createElement('div');
        this._tooltipEl.className = 'archetype-tooltip';
        this._tooltipEl.setAttribute('style', 'display: none;');
    }

    /**
     * Show tooltip above a card element.
     */
    _showTooltip(card, text) {
        if (!text || !this._tooltipEl) return;
        this._tooltipEl.textContent = text;
        card.style.position = 'relative';
        card.appendChild(this._tooltipEl);
        this._tooltipEl.setAttribute('style', 'display: block;');
    }

    /**
     * Hide the tooltip.
     */
    _hideTooltip() {
        if (!this._tooltipEl) return;
        this._tooltipEl.setAttribute('style', 'display: none;');
        if (this._tooltipEl.parentNode) {
            this._tooltipEl.parentNode.removeChild(this._tooltipEl);
        }
    }

    _bindEvents() {
        const on = (event, handler) => {
            this._session.on(event, handler);
            this._sessionListeners.push({ event, handler });
        };

        // Build carousel immediately when ready.
        on('carouselReady', (data) => {
            this._rebuild(data.scores);
        });

        // Background scoring update — update individual card stats/palettes
        on('archetypeScored', (data) => {
            this._updateCardWithScoredData(data);
        });

        on('archetypeChanged', (data) => {
            this._activeId = data.archetypeId;
            this._updateActiveCard();
        });

        on('configChanged', (config) => {
            // In Engineer, engine ID might come through in various ways
            if (config.engineId && config.engineId !== this._activeId) {
                this._activeId = config.engineId;
                this._updateActiveCard();
            }
        });

        // Rebuild swatches AFTER posterization completes
        on('previewUpdated', (data) => this._refreshActiveSwatches(data));

        // Dirty indicator
        on('knobsCustomizedChanged', () => {
            this._updateCustomizedBadge(this._session.isCustomized());
        });
        on('paletteChanged', () => {
            this._updateCustomizedBadge(this._session.isCustomized());
        });
    }

    /**
     * Rebuild the card strip with the 7 goddess engines.
     */
    _rebuild(scores) {
        const state = this._session.getState();
        this._activeId = state.activeArchetypeId;

        const goddessIds = ['aine', 'anu', 'brigid', 'cailleach', 'morrigan', 'rhiannon', 'rusalka'];

        this._container.innerHTML = '';

        for (const id of goddessIds) {
            const engineDef = EngineRegistry.get(id);
            if (!engineDef) continue;

            const card = this._createCard(id, engineDef);
            this._container.appendChild(card);
        }

        this._scrollToActive();
    }

    /**
     * Add a dummy method for backward compatibility with existing listeners.
     */
    sortByDisplayedDeltaE() {
        // TODO: Implement actual re-ordering logic if needed.
        logger.log('[ArchetypeCarousel] sortByDisplayedDeltaE called (noop)');
    }

    /**
     * Create a single engine card element.
     */
    _createCard(id, engineDef) {
        const isActive = id === this._activeId;
        const card = document.createElement('div');
        card.className = 'carousel-card' + (isActive ? ' active' : '');
        card.dataset.id = id;

        const name = engineDef.name || id.charAt(0).toUpperCase() + id.slice(1);
        const description = engineDef.description || '';

        card.innerHTML = `<div class="card-name">${name}</div>`;

        // Click → swap engine
        card.addEventListener('pointerup', (e) => {
            if (id !== this._activeId) {
                const overlay = document.getElementById('processing-overlay');
                if (overlay) overlay.classList.add('visible');
                card.classList.add('scoring');

                setTimeout(() => {
                    this._session.swapArchetype(id)
                        .then(() => {
                            card.classList.remove('scoring');
                            if (overlay) overlay.classList.remove('visible');
                        })
                        .catch(err => {
                            card.classList.remove('scoring');
                            if (overlay) overlay.classList.remove('visible');
                            logger.error(`[ArchetypeCarousel] swapEngine failed: ${err.message}`);
                        });
                }, 30);
            }
        });

        // Hover: tooltip
        card.addEventListener('mouseenter', () => {
            this._hoveredId = id;
            if (description) this._showTooltip(card, description);
        });

        card.addEventListener('mouseleave', () => {
            this._hoveredId = null;
            this._hideTooltip();
        });

        return card;
    }

    /**
     * Get RGB palette colors that have at least one pixel assigned.
     */
    _getActiveRgbPalette() {
        const sep = this._session.getSeparationState();
        if (!sep) return null;
        const { rgbPalette, colorIndices } = sep;
        if (!rgbPalette || !colorIndices) return null;

        const counts = new Uint32Array(rgbPalette.length);
        for (let i = 0, len = colorIndices.length; i < len; i++) counts[colorIndices[i]]++;

        return rgbPalette.filter((_, i) => counts[i] > 0);
    }

    /**
     * Update which card has the 'active' highlight.
     */
    _updateActiveCard() {
        const cards = this._container.querySelectorAll('.carousel-card');
        cards.forEach(card => {
            card.classList.toggle('active', card.dataset.id === this._activeId);
        });
        this._scrollToActive();
    }

    /**
     * Refresh swatches on the active card.
     */
    _refreshActiveSwatches(data) {
        if (!this._activeId) return;
        
        this._updateCardWithScoredData({
            id: this._activeId,
            rgbPalette: this._getActiveRgbPalette(),
            meanDeltaE: data.accuracyDeltaE,
            targetColors: data.activeColorCount
        });
    }

    /**
     * Update a specific card with background scored data.
     * @private
     */
    _updateCardWithScoredData(data) {
        const card = this._container.querySelector(`.carousel-card[data-id="${data.id}"]`);
        if (!card) return;

        // 1. Update Swatches
        if (data.rgbPalette && data.rgbPalette.length > 0) {
            let swatchRow = card.querySelector('.card-swatches');
            if (!swatchRow) {
                swatchRow = document.createElement('div');
                swatchRow.className = 'card-swatches';
                card.appendChild(swatchRow);
            }
            swatchRow.innerHTML = data.rgbPalette.map(c =>
                `<span class="card-swatch" style="background:rgb(${c.r},${c.g},${c.b})"></span>`
            ).join('');
        }

        // 2. Update Metrics (optional: add ΔE badges here if needed)
    }

    /**
     * Show or remove the orange "customized" dot.
     */
    _updateCustomizedBadge(customized) {
        const activeCard = this._container.querySelector('.carousel-card.active');
        if (!activeCard) return;

        const nameEl = activeCard.querySelector('.card-name');
        if (!nameEl) return;

        const existing = nameEl.querySelector('.card-customized');
        if (existing) existing.remove();

        if (customized) {
            const dot = document.createElement('span');
            dot.className = 'card-customized';
            dot.textContent = '\u2022';
            nameEl.appendChild(dot);
        }
    }

    _scrollToActive() {
        const activeCard = this._container.querySelector('.carousel-card.active');
        if (activeCard) {
            activeCard.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
        }
    }
}

module.exports = ArchetypeCarousel;
