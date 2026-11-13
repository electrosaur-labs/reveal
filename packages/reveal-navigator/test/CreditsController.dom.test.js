/**
 * CreditsController.dom.test.js
 * Headless DOM test suite for the Hollywood-style crawling credits window.
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
        expect(document.getElementById('btn-credits-playpause')).not.toBeNull();
        expect(document.getElementById('btn-credits-replay')).not.toBeNull();
        expect(document.getElementById('btn-credits-close')).not.toBeNull();
        expect(document.getElementById('btn-show-credits')).not.toBeNull();
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

    it('toggles play/pause state and updates button label', () => {
        controller.open();
        expect(controller.isPlaying).toBe(true);
        expect(controller.btnPlayPause.textContent).toContain('Pause');

        controller.togglePlayPause();
        expect(controller.isPlaying).toBe(false);
        expect(controller.btnPlayPause.textContent).toContain('Play');

        controller.togglePlayPause();
        expect(controller.isPlaying).toBe(true);
        expect(controller.btnPlayPause.textContent).toContain('Pause');
    });

    it('resets scroll position to 0 on replay()', () => {
        controller.open();
        controller.viewport.scrollTop = 150;
        expect(controller.viewport.scrollTop).toBe(150);

        controller.replay();
        expect(controller.viewport.scrollTop).toBe(0);
        expect(controller.isPlaying).toBe(true);
    });

    it('toggles hover state on mouseenter/mouseleave for hover-to-pause', () => {
        expect(controller.isHovered).toBe(false);

        controller.viewport.dispatchEvent(new window.Event('mouseenter'));
        expect(controller.isHovered).toBe(true);

        controller.viewport.dispatchEvent(new window.Event('mouseleave'));
        expect(controller.isHovered).toBe(false);
    });

    it('wires the close button click to dismiss the credits window', () => {
        controller.open();
        expect(overlay.style.display).toBe('flex');

        controller.btnClose.dispatchEvent(new window.Event('click'));
        expect(overlay.style.display).toBe('none');
        expect(controller.isPlaying).toBe(false);
    });

    it('triggers and dismisses the Doug Minkler Manifesto Easter Egg', () => {
        controller.open();
        const broadside = document.getElementById('manifesto-broadside');
        const emblem = document.getElementById('credits-emblem');
        const btnManifestoClose = document.getElementById('btn-manifesto-close');

        expect(broadside.style.display).toBe('none');

        // Click emblem to reveal manifesto
        emblem.dispatchEvent(new window.Event('click'));
        expect(broadside.style.display).toBe('flex');
        expect(controller.isManifestoOpen).toBe(true);
        expect(controller.isPlaying).toBe(false); // Crawl pauses

        // Click close button to return to crawl
        btnManifestoClose.dispatchEvent(new window.Event('click'));
        expect(broadside.style.display).toBe('none');
        expect(controller.isManifestoOpen).toBe(false);
        expect(controller.isPlaying).toBe(true); // Crawl resumes
    });

    it('navigates backwards via Escape key: manifesto -> crawl -> closed', () => {
        controller.open();
        const broadside = document.getElementById('manifesto-broadside');
        const emblem = document.getElementById('credits-emblem');

        // Open manifesto
        emblem.dispatchEvent(new window.Event('click'));
        expect(controller.isManifestoOpen).toBe(true);

        // First Escape: closes manifesto, keeps credits open
        window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
        expect(controller.isManifestoOpen).toBe(false);
        expect(broadside.style.display).toBe('none');
        expect(overlay.style.display).toBe('flex');

        // Second Escape: closes credits overlay completely
        window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
        expect(overlay.style.display).toBe('none');
        expect(controller.isPlaying).toBe(false);
    });
});
