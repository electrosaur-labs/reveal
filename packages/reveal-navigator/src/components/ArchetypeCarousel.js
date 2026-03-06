/**
 * ArchetypeCarousel - Horizontal card strip for archetype navigation
 *
 * Two-phase rendering:
 *   1. carouselReady — builds cards immediately with DNA scores (~400ms)
 *   2. scoringComplete — rebuilds with ΔE-sorted order (~7-18s background)
 *
 * Active card shows real palette swatches from proxy separation.
 * Vanilla+ pattern: subscribes to SessionState events.
 */

const Reveal = require("@electrosaur-labs/core");
const logger = require('@electrosaur-labs/core').logger;

// Sector → approximate hue for visual indicator
const SECTOR_HUES = {
    red: 0, orange: 30, yellow: 60, chartreuse: 90,
    green: 120, cyan: 180, azure: 210, blue: 240,
    purple: 270, magenta: 300, pink: 330, rose: 345
};

class ArchetypeCarousel {

    /**
     * @param {HTMLElement} container - DOM element to render cards into
     * @param {import('../state/SessionState')} sessionState
     */
    constructor(container, sessionState) {
        this._container = container;
        this._session = sessionState;
        this._cards = [];           // Ranked archetype data
        this._activeId = null;      // Currently active archetype
        this._hoveredId = null;
        this._activeFilter = 'all'; // Current group filter
        this._activeSort = 'score'; // Current sort axis
        this._sortAscending = true; // Sort direction
        this._eagerSet = null;      // Set of tier-1 archetype IDs (scored eagerly)

        // Listener bookkeeping for destroy() cleanup
        this._chipListeners = [];   // [{element, event, handler}]
        this._sessionListeners = []; // [{event, handler}]

        this._initFilterChips();
        this._initSortChips();
        this._initTooltip();
        this._bindEvents();
    }

    /**
     * Clean up all event listeners and DOM content.
     * Call before discarding the carousel instance.
     */
    destroy() {
        // Remove DOM chip listeners
        for (const { element, event, handler } of this._chipListeners) {
            element.removeEventListener(event, handler);
        }
        this._chipListeners = [];

        // Remove session event listeners
        for (const { event, handler } of this._sessionListeners) {
            this._session.off(event, handler);
        }
        this._sessionListeners = [];

        // Clear card DOM (implicitly removes card-level listeners)
        this._container.innerHTML = '';
        this._cards = [];
    }

    /**
     * Initialize filter chip click handlers.
     */
    _initFilterChips() {
        this._filtersContainer = document.getElementById('carousel-filters');
        if (!this._filtersContainer) return;

        const chips = this._filtersContainer.querySelectorAll('.filter-chip');
        chips.forEach(chip => {
            const handler = () => this._setFilter(chip.dataset.group);
            chip.addEventListener('pointerup', handler);
            this._chipListeners.push({ element: chip, event: 'pointerup', handler });
        });
    }

    /**
     * Initialize sort chip click handlers.
     */
    _initSortChips() {
        this._sortContainer = document.getElementById('carousel-sort');
        if (!this._sortContainer) return;

        const chips = this._sortContainer.querySelectorAll('.sort-chip');
        chips.forEach(chip => {
            const handler = () => {
                const axis = chip.dataset.sort;
                if (axis === this._activeSort) {
                    // Same chip: toggle direction
                    this._sortAscending = !this._sortAscending;
                } else {
                    // New chip: default direction per axis
                    this._activeSort = axis;
                    // DNA: higher is better (descending), others: lower is better (ascending)
                    this._sortAscending = axis !== 'dna';
                }
                this._applySortChipState();
                this._sortCards();
            };
            chip.addEventListener('pointerup', handler);
            this._chipListeners.push({ element: chip, event: 'pointerup', handler });
        });
    }

    /**
     * Update sort chip visual state (active + arrow direction).
     */
    _applySortChipState() {
        if (!this._sortContainer) return;
        const chips = this._sortContainer.querySelectorAll('.sort-chip');
        chips.forEach(chip => {
            const isActive = chip.dataset.sort === this._activeSort;
            chip.classList.toggle('active', isActive);
            const arrow = chip.querySelector('.sort-arrow');
            if (arrow) arrow.textContent = isActive ? (this._sortAscending ? '\u25B2' : '\u25BC') : '';
        });
    }

    /**
     * Sort cards in the DOM by the active sort axis.
     */
    _sortCards() {
        // Only sort non-pinned cards in the main carousel
        const cards = Array.from(this._container.querySelectorAll('.carousel-card'));
        if (cards.length === 0) return;

        const axis = this._activeSort;
        const asc = this._sortAscending;

        // Pin order for meta-archetypes (always at top regardless of sort axis)
        const PIN_ORDER = { 'dynamic_interpolator': 0, 'distilled': 1, 'salamander': 2 };

        cards.sort((a, b) => {
            const aPin = PIN_ORDER[a.dataset.id];
            const bPin = PIN_ORDER[b.dataset.id];
            const aPinned = aPin !== undefined;
            const bPinned = bPin !== undefined;

            // Unscored (grayed) cards sink to bottom, preserving DNA order among themselves
            const aUnscored = a.classList.contains('unscored');
            const bUnscored = b.classList.contains('unscored');
            if (aUnscored && !bUnscored) return 1;
            if (!aUnscored && bUnscored) return -1;
            if (aUnscored && bUnscored) {
                const aDna = parseFloat(a.dataset.dnaScore) || 0;
                const bDna = parseFloat(b.dataset.dnaScore) || 0;
                return bDna - aDna;
            }

            // Pinned cards always sort to top
            if (aPinned && bPinned) {
                const aSort = parseFloat(a.dataset.sortScore);
                const bSort = parseFloat(b.dataset.sortScore);
                if (!isNaN(aSort) && !isNaN(bSort)) return aSort - bSort;
                return aPin - bPin;
            }
            if (aPinned) return -1;
            if (bPinned) return 1;

            let aVal, bVal;
            if (axis === 'score') {
                aVal = parseFloat(a.dataset.sortScore) || 999;
                bVal = parseFloat(b.dataset.sortScore) || 999;
            } else if (axis === 'de') {
                aVal = parseFloat(a.dataset.deltaE) || 999;
                bVal = parseFloat(b.dataset.deltaE) || 999;
            } else if (axis === 'dna') {
                aVal = parseFloat(a.dataset.dnaScore) || 0;
                bVal = parseFloat(b.dataset.dnaScore) || 0;
            } else if (axis === 'screens') {
                aVal = parseInt(a.dataset.screenCount) || 999;
                bVal = parseInt(b.dataset.screenCount) || 999;
            }
            const primary = asc ? aVal - bVal : bVal - aVal;
            if (primary !== 0) return primary;
            // Tiebreak by sortScore ascending (best composite quality first)
            const aScore = parseFloat(a.dataset.sortScore) || 999;
            const bScore = parseFloat(b.dataset.sortScore) || 999;
            return aScore - bScore;
        });

        // Re-insert sorted, update debug indices, apply recommended badges
        let recommendedCount = 0;
        for (let i = 0; i < cards.length; i++) {
            this._container.appendChild(cards[i]);

            // Recommended badges only when sorted by score (the composite metric)
            const oldBadge = cards[i].querySelector('.recommended-badge');
            if (oldBadge) oldBadge.remove();
            cards[i].classList.remove('recommended');
            if (axis === 'score') {
                const sortVal = parseFloat(cards[i].dataset.sortScore);
                if (!isNaN(sortVal) && sortVal < 900 && recommendedCount < 3) {
                    cards[i].classList.add('recommended');
                    recommendedCount++;
                }
            }

        }

        this._scrollToActive();
    }

    /**
     * Apply a group filter to the carousel cards.
     * @param {string} group - 'all', 'faithful', 'graphic', or 'dramatic'
     */
    _setFilter(group) {
        this._activeFilter = group;

        // Update chip highlight
        if (this._filtersContainer) {
            const chips = this._filtersContainer.querySelectorAll('.filter-chip');
            chips.forEach(chip => {
                chip.classList.toggle('active', chip.dataset.group === group);
            });
        }

        // Show/hide cards based on group
        const cards = this._container.querySelectorAll('.carousel-card');
        cards.forEach(card => {
            const cardGroup = card.dataset.group;
            const visible = group === 'all' || cardGroup === group;
            card.setAttribute('style', visible ? '' : 'display: none;');
        });
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
     * @param {HTMLElement} card
     * @param {string} text
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

    /**
     * Derive trait badges from archetype parameters.
     * @param {Object} archetype
     * @returns {string[]} Trait names
     */
    _deriveTraits(archetype) {
        const params = archetype.parameters;
        if (!params) return [];

        const traits = [];
        if (params.blackBias > 5) traits.push('High Contrast');
        if (params.vibrancyBoost > 1.3) traits.push('Vivid');
        if (params.vibrancyBoost < 1.0 ||
            (params.vibrancyMode === 'linear' && params.blackBias < 3)) {
            traits.push('Soft');
        }
        if (params.vibrancyMode === 'linear' && params.paletteReduction >= 10) {
            traits.push('Flat');
        }
        return traits;
    }

    _bindEvents() {
        const on = (event, handler) => {
            this._session.on(event, handler);
            this._sessionListeners.push({ event, handler });
        };

        // Build carousel immediately when top-match preview is ready (DNA scores only).
        on('carouselReady', (data) => {
            this._rebuild(data.scores, data.eagerSet);
        });
        // Update individual card ΔE + edge survival as each archetype is scored in the background.
        on('archetypeScored', (data) => {
            this._updateCardDeltaE(data.id, data.meanDeltaE, data.targetColors, data.sortScore, data.edgeSurvival);
        });
        // All scored — sort by displayed ΔE (includes live values from clicked cards).
        on('scoringComplete', () => {
            this.sortByDisplayedDeltaE();
        });
        on('archetypeChanged', (data) => {
            this._activeId = data.archetypeId;
            this._updateActiveCard();
        });
        on('configChanged', (config) => {
            if (config.id && config.id !== this._activeId) {
                this._activeId = config.id;
                this._updateActiveCard();
            }
        });
        // Rebuild swatches AFTER posterization completes (not before)
        on('previewUpdated', (data) => this._refreshActiveSwatches(data));

        // Dirty indicator — orange dot when knobs OR palette surgery is customized
        on('knobsCustomizedChanged', () => {
            this._updateCustomizedBadge(this._session.isCustomized());
        });
        on('paletteChanged', () => {
            this._updateCustomizedBadge(this._session.isCustomized());
        });
    }

    /**
     * Rebuild the full card strip from scored archetypes.
     * All cards are created and visible. Tier-1 (eager) cards get background-
     * scored with ΔE/edge data; tier-2 cards are grayed out until clicked.
     *
     * @param {Array} [scores] - Pre-sorted scores (by DNA or ΔE).
     * @param {Set<string>} [eagerSet] - Tier-1 IDs that will be eager-scored
     */
    _rebuild(scores, eagerSet) {
        if (!scores) scores = this._session.getAllArchetypeScores();
        if (!scores || scores.length === 0) return;

        const archetypes = Reveal.ArchetypeLoader.loadArchetypes();
        const archetypeMap = new Map(archetypes.map(a => [a.id, a]));

        // Active archetype from session state
        const state = this._session.getState();
        this._activeId = state.activeArchetypeId;

        this._cards = scores;
        this._eagerSet = eagerSet || null;

        const SYNTHETIC_IDS = new Set(['dynamic_interpolator', 'distilled', 'salamander']);

        this._container.innerHTML = '';
        this._expanded = false;
        this._pendingCards = [];

        for (let i = 0; i < scores.length; i++) {
            const match = scores[i];
            // Chameleon is synthetic — not in ArchetypeLoader
            const archetype = archetypeMap.get(match.id) || match._synthetic;
            if (!archetype) continue;

            const isSynth = SYNTHETIC_IDS.has(match.id);
            const isTier1 = !eagerSet || eagerSet.has(match.id);
            const card = this._createCard(match, archetype, i);
            card.dataset.tier = isTier1 ? '1' : '2';

            if (!isTier1) {
                card.classList.add('unscored');
            }

            if (isSynth) {
                card.classList.add('synthetic');
                this._container.appendChild(card);
            } else {
                // Stash non-synthetic cards; revealed on "More" click
                this._pendingCards.push(card);
            }
        }

        // Add "More" button after synthetic cards
        this._moreBtn = document.createElement('div');
        this._moreBtn.className = 'carousel-card carousel-more';
        this._moreBtn.innerHTML = `<div class="card-name">More\u2026</div>`;
        this._moreBtn.addEventListener('pointerup', () => this._expandCarousel());
        this._container.appendChild(this._moreBtn);

        // Hide filter+sort until expanded (only synthetics visible initially)
        const filterRow = document.getElementById('carousel-filter-row');
        if (filterRow) filterRow.setAttribute('style', 'display: none;');

        // Scroll active card into view
        this._scrollToActive();
    }

    /**
     * Expand the carousel: replace "More" with all remaining archetype cards.
     */
    _expandCarousel() {
        if (this._expanded) return;
        this._expanded = true;

        // Remove "More" button
        if (this._moreBtn && this._moreBtn.parentNode) {
            this._moreBtn.remove();
        }

        // Append all stashed cards
        for (const card of this._pendingCards) {
            this._container.appendChild(card);
        }
        this._pendingCards = [];

        // Show filter+sort row
        const filterRow = document.getElementById('carousel-filter-row');
        if (filterRow) filterRow.setAttribute('style', 'display: flex;');
        if (this._sortContainer) {
            this._sortContainer.setAttribute('style', 'display: flex;');
        }

        // Apply current filter and sort
        if (this._activeFilter !== 'all') {
            this._setFilter(this._activeFilter);
        }
        this._sortCards();
        this._scrollToActive();
    }

    /**
     * Create a single archetype card element.
     * All cards start with hue indicators; only the active card
     * gets real swatches via _refreshActiveSwatches after posterization.
     */
    _createCard(match, archetype, sortIndex) {
        const isSynthetic = match.id === 'dynamic_interpolator' || match.id === 'distilled' || match.id === 'salamander';
        const isActive = match.id === this._activeId;
        const card = document.createElement('div');
        card.className = 'carousel-card' + (isActive ? ' active' : '');
        card.dataset.id = match.id;
        card.dataset.group = isSynthetic ? 'specialist' : (archetype.group || 'all');

        // Score bar — inverted sortScore (bigger = better, 0-100) when available, else DNA
        const hasSort = match.sortScore != null;
        const hasEdge = match.edgeSurvival != null;
        const hasDE = match.meanDeltaE != null;
        const hasScore = match.score != null;
        const scorePercent = hasSort
            ? Math.min(100, Math.max(0, 100 - match.sortScore / 9))
            : hasScore ? Math.min(100, Math.max(0, match.score)) : 0;

        const deStr = hasDE ? match.meanDeltaE.toFixed(1) : '-';
        const edgeStr = hasEdge ? (match.edgeSurvival * 100).toFixed(0) + '%' : '-';
        const colorsStr = match.targetColors ? `${match.targetColors}c` : '';
        const dnaStr = match.score != null ? match.score.toFixed(0) + '%' : '';
        if (match.sortScore != null) card.dataset.sortScore = match.sortScore.toFixed(2);
        if (match.meanDeltaE != null) card.dataset.deltaE = match.meanDeltaE.toFixed(2);
        if (match.score != null) card.dataset.dnaScore = match.score.toFixed(2);
        if (match.targetColors != null) card.dataset.screenCount = match.targetColors;
        const hueIndicator = this._buildHueIndicator(archetype);
        card.dataset.hueHtml = hueIndicator;

        const sortStr = match.sortScore != null ? Math.round(Math.min(100, Math.max(0, 100 - match.sortScore / 9))) : '';
        card.title = `\u0394E ${deStr} \u00b7 Edge ${edgeStr} \u00b7 ${colorsStr || '?'} screens \u00b7 DNA ${dnaStr}`;
        card.innerHTML =
            `<div class="card-name">${archetype.name}</div>` +
            `<div class="card-score-row">` +
                `<div class="card-score-bar"><div class="card-score-fill" style="width:${scorePercent}%"></div></div>` +
                `<span class="card-sort-label">${sortStr}</span>` +
            `</div>` +
            `<div class="card-hue">${hueIndicator}</div>`;

        // Store description for tooltip
        const description = archetype.description || '';
        card.dataset.description = description;

        // Click → swap archetype
        // Use pointerup instead of click: UXP scrollable containers consume
        // the first click for focus, requiring a double-click to activate.
        card.addEventListener('pointerup', (e) => {
            if (match.id !== this._activeId) {
                this._session.swapArchetype(match.id)
                    .catch(err => logger.error(`[ArchetypeCarousel] swapArchetype failed: ${err.message}`));
            }
        });

        // Hover: tooltip + highlight
        card.addEventListener('mouseenter', () => {
            this._hoveredId = match.id;
            if (description) this._showTooltip(card, description);
        });

        card.addEventListener('mouseleave', () => {
            this._hoveredId = null;
            this._hideTooltip();
        });

        return card;
    }

    /**
     * Build a small hue dot strip from archetype preferred_sectors.
     */
    _buildHueIndicator(archetype) {
        const sectors = archetype.preferred_sectors || [];
        if (sectors.length === 0) {
            // Synthetic/universal — rainbow strip
            return [0, 30, 60, 120, 210, 300].map(h =>
                `<span class="card-swatch" style="background:hsl(${h},60%,50%)"></span>`
            ).join('');
        }
        return sectors.slice(0, 5).map(sector => {
            const hue = SECTOR_HUES[sector] !== undefined ? SECTOR_HUES[sector] : 0;
            return `<span class="card-swatch" style="background:hsl(${hue},60%,50%)"></span>`;
        }).join('');
    }

    /**
     * Get RGB palette colors that have at least one pixel assigned.
     * Filters out zero-coverage slots left by minVolume/merge so the
     * active card swatches match what PaletteSurgeon displays.
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
     * Update a single card's displayed ΔE + edge survival from a background scoring event.
     * Skips the active card — its ΔE is synced to the live value by previewUpdated.
     */
    _updateCardDeltaE(id, meanDeltaE, targetColors, sortScore, edgeSurvival) {
        let card = this._container.querySelector(`.carousel-card[data-id="${id}"]`);
        if (!card && this._pendingCards) {
            card = this._pendingCards.find(c => c.dataset.id === id);
        }
        if (!card) return;

        // Card has been scored — remove grayed-out state
        card.classList.remove('unscored');

        const de = meanDeltaE.toFixed(1);
        const edgeStr = edgeSurvival != null ? (edgeSurvival * 100).toFixed(0) + '%' : '-';
        const colorsStr = targetColors ? `${targetColors}c` : '';
        if (sortScore != null) card.dataset.sortScore = sortScore.toFixed(2);
        card.dataset.deltaE = meanDeltaE.toFixed(2);
        if (targetColors != null) card.dataset.screenCount = targetColors;
        const scoreFill = card.querySelector('.card-score-fill');
        const inverted = sortScore != null ? Math.min(100, Math.max(0, 100 - sortScore / 9)) : null;
        if (scoreFill && inverted != null) {
            scoreFill.style.width = inverted + '%';
        }
        // Update sort score label on the card (inverted: bigger = better)
        const sortLabel = card.querySelector('.card-sort-label');
        if (sortLabel && inverted != null) {
            sortLabel.textContent = Math.round(inverted);
        }
        // Update tooltip with full details
        card.title = `\u0394E ${de} \u00b7 Edge ${edgeStr} \u00b7 ${colorsStr || '?'} screens`;
    }

    /**
     * Update which card has the 'active' highlight.
     * Does NOT refresh swatches — that's done by previewUpdated after
     * posterization completes with correct palette data.
     */
    _updateActiveCard() {
        // Auto-expand if active card is in pending list
        if (!this._expanded && this._pendingCards && this._pendingCards.some(c => c.dataset.id === this._activeId)) {
            this._expandCarousel();
        }
        const cards = this._container.querySelectorAll('.carousel-card');
        cards.forEach(card => {
            card.classList.toggle('active', card.dataset.id === this._activeId);
        });
        this._scrollToActive();
    }

    /**
     * Refresh swatches + stats on the active card AFTER posterization completes.
     * Also reverts all non-active cards back to hue indicators.
     *
     * @param {Object} data - previewUpdated event data (palette, elapsedMs, accuracyDeltaE)
     */
    _refreshActiveSwatches(data) {
        const cards = this._container.querySelectorAll('.carousel-card');

        cards.forEach(card => {
            const isActive = card.classList.contains('active');

            if (isActive) {
                card.classList.remove('unscored');

                const rgbPalette = this._getActiveRgbPalette();
                if (!rgbPalette || rgbPalette.length === 0) return;

                // Remove hue indicator
                const hueRow = card.querySelector('.card-hue');
                if (hueRow) hueRow.remove();

                // Create or update swatch row
                let swatchRow = card.querySelector('.card-swatches');
                if (!swatchRow) {
                    swatchRow = document.createElement('div');
                    swatchRow.className = 'card-swatches';
                    card.appendChild(swatchRow);
                }
                swatchRow.innerHTML = rgbPalette.map(c =>
                    `<span class="card-swatch" style="background:rgb(${c.r},${c.g},${c.b})"></span>`
                ).join('');

            } else if (!card.querySelector('.card-swatches') && !card.classList.contains('synthetic')) {
                // Non-active, non-synthetic: restore hue indicator if missing
                if (!card.querySelector('.card-hue')) {
                    const hueDiv = document.createElement('div');
                    hueDiv.className = 'card-hue';
                    hueDiv.innerHTML = card.dataset.hueHtml || '';
                    card.appendChild(hueDiv);
                }
            }
        });
    }

    /**
     * Show or remove the orange "customized" dot on the active card's name.
     * @param {boolean} customized
     */
    _updateCustomizedBadge(customized) {
        const activeCard = this._container.querySelector('.carousel-card.active');
        if (!activeCard) return;

        const nameEl = activeCard.querySelector('.card-name');
        if (!nameEl) return;

        // Remove existing badge if any
        const existing = nameEl.querySelector('.card-customized');
        if (existing) existing.remove();

        if (customized) {
            const dot = document.createElement('span');
            dot.className = 'card-customized';
            dot.textContent = '\u2022';
            nameEl.appendChild(dot);
        }
    }

    /**
     * Re-sort carousel cards after scoring completes.
     * Switches to score sort (the composite metric) and re-sorts.
     */
    sortByDisplayedDeltaE() {
        this._activeSort = 'score';
        this._sortAscending = true;
        this._applySortChipState();
        // If not expanded, auto-expand now that scoring is complete
        if (!this._expanded) this._expandCarousel();
        this._sortCards();
    }

    _scrollToActive() {
        const activeCard = this._container.querySelector('.carousel-card.active');
        if (activeCard) {
            activeCard.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
        }
    }
}

module.exports = ArchetypeCarousel;
