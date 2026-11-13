/**
 * CreditsController.dom.test.js
 * Headless DOM test suite for the theatrical credits window and Minkler Manifesto.
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const CreditsController = require('../src/components/CreditsController');

describe('CreditsController Headless DOM Suite', () => {
    let dom;
    let window;
    let document;
    let controller;
    let overlay;
    const origPerformance = global.performance;

    beforeEach(() => {
        const htmlPath = path.join(__dirname, '../src/index.html');
        const htmlContent = fs.readFileSync(htmlPath, 'utf-8');

        dom = new JSDOM(htmlContent, { runScripts: 'dangerously' });
        window = dom.window;
        document = window.document;

        global.window = window;
        global.document = document;
        global.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
        global.cancelAnimationFrame = (id) => clearTimeout(id);

        overlay = document.getElementById('credits-overlay');
        controller = new CreditsController(overlay);
    });

    afterEach(() => {
        if (controller) controller.close();
        delete global.window;
        delete global.document;
        global.performance = origPerformance;
        delete global.requestAnimationFrame;
        delete global.cancelAnimationFrame;
    });

    it('verifies that all credits DOM elements exist in index.html', () => {
        expect(overlay).not.toBeNull();
        expect(document.getElementById('credits-window')).not.toBeNull();
        expect(document.getElementById('credits-viewport')).not.toBeNull();
        expect(document.getElementById('credits-crawl')).not.toBeNull();
        expect(document.getElementById('btn-show-credits')).not.toBeNull();
        expect(document.getElementById('credits-emblem')).not.toBeNull();
        expect(document.getElementById('credits-print-trigger')).not.toBeNull();
        expect(document.getElementById('manifesto-broadside')).not.toBeNull();
    });

    it('opens and closes the overlay with proper playback state', () => {
        expect(overlay.style.display).toBe('none');

        controller.open();
        expect(overlay.style.display).toBe('flex');
        expect(controller.isPlaying).toBe(true);

        controller.close();
        expect(overlay.style.display).toBe('none');
        expect(controller.isPlaying).toBe(false);
    });

    it('dismisses credits window when clicking the dark backdrop outside the window', () => {
        controller.open();
        expect(overlay.style.display).toBe('flex');

        // Click directly on overlay backdrop
        overlay.dispatchEvent(new window.Event('click'));
        expect(overlay.style.display).toBe('none');
        expect(controller.isPlaying).toBe(false);
    });

    it('toggles hover state on mouseenter/mouseleave for hover-to-pause', () => {
        expect(controller.isHovered).toBe(false);

        controller.viewport.dispatchEvent(new window.Event('mouseenter'));
        expect(controller.isHovered).toBe(true);

        controller.viewport.dispatchEvent(new window.Event('mouseleave'));
        expect(controller.isHovered).toBe(false);
    });

    it('pauses ambient crawl when user manually interacts with wheel or pointer', () => {
        controller.open();
        expect(controller.isPlaying).toBe(true);

        // User interacts with mousewheel
        controller.viewport.dispatchEvent(new window.Event('wheel'));
        expect(controller.isPlaying).toBe(false);
        expect(controller.userHasScrolled).toBe(true);
    });

    it('triggers and dismisses the Doug Minkler Manifesto Easter Egg via mascot and print', () => {
        controller.open();
        const broadside = document.getElementById('manifesto-broadside');
        const emblem = document.getElementById('credits-emblem');
        const printTrigger = document.getElementById('credits-print-trigger');

        expect(broadside.style.display).toBe('none');
        expect(printTrigger).not.toBeNull();

        // Click print trigger to reveal manifesto
        printTrigger.dispatchEvent(new window.Event('click'));
        expect(broadside.style.display).toBe('flex');
        expect(controller.isManifestoOpen).toBe(true);
        expect(controller.isPlaying).toBe(false); // Crawl pauses

        // Close manifesto programmatically
        controller.closeManifesto();
        expect(broadside.style.display).toBe('none');
        expect(controller.isManifestoOpen).toBe(false);

        // Click emblem to reveal manifesto again
        emblem.dispatchEvent(new window.Event('click'));
        expect(broadside.style.display).toBe('flex');
        expect(controller.isManifestoOpen).toBe(true);
    });

    it('navigates backwards via Escape key (manifesto -> credits -> closed overlay) while keeping plugin dialog alive', () => {
        const dialog = document.getElementById('navigatorDialog');
        dialog.close = vi.fn();

        controller.open();
        const broadside = document.getElementById('manifesto-broadside');
        const emblem = document.getElementById('credits-emblem');

        // Open manifesto
        emblem.dispatchEvent(new window.Event('click'));
        expect(controller.isManifestoOpen).toBe(true);

        // First Escape: closes manifesto, keeps credits open, does NOT close plugin dialog
        window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
        expect(controller.isManifestoOpen).toBe(false);
        expect(broadside.style.display).toBe('none');
        expect(overlay.style.display).toBe('flex');
        expect(dialog.close).not.toHaveBeenCalled();

        // Second Escape: closes credits overlay completely, returns to Navigator, does NOT close plugin dialog
        window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
        expect(overlay.style.display).toBe('none');
        expect(controller.isPlaying).toBe(false);
        expect(dialog.close).not.toHaveBeenCalled();
    });
});
