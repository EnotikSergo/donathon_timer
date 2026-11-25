(function () {
    'use strict';

    const bridge = window.timerBridge || null;
    const isWindow = !!bridge;
    const root = document.documentElement;
    root.classList.toggle('mode-window', isWindow);
    root.classList.toggle('mode-overlay', !isWindow);

    const el = {
        container: document.getElementById('container'),
        time: document.getElementById('timeText'),
        stopwatch: document.getElementById('stopwatchText'),
        price: document.getElementById('rubPerHourText'),
        goalText: document.getElementById('goalText'),
        goalFill: document.getElementById('goalBarFill')
    };

    const PAUSE_ICON_DELAY = 700;
    const DEFAULT_PRICE_FONT_SIZE = 3.7;
    const MIN_PRICE_FONT_SIZE = 0.5;
    const PRICE_FONT_STEP = 0.2;

    let current = null;
    let pauseIconTimer = null;
    let dragging = false;

    function setText(node, text) {
        if (node.textContent !== text) node.textContent = text;
    }

    function toggle(name, on) {
        el.container.classList.toggle(name, !!on);
    }

    function applyPause(isPause, immediate) {
        if (pauseIconTimer) {
            clearTimeout(pauseIconTimer);
            pauseIconTimer = null;
        }
        if (!isPause) {
            toggle('paused-icon', false);
        } else if (immediate) {
            toggle('paused-icon', true);
        } else {
            pauseIconTimer = setTimeout(() => toggle('paused-icon', true), PAUSE_ICON_DELAY);
        }
    }

    function applyPriceLabel(label) {
        if (dragging) return;
        const hasPosition = !!(label && label.left && label.top);
        el.price.classList.toggle('positioned', hasPosition);
        el.price.style.left = hasPosition ? label.left : '';
        el.price.style.top = hasPosition ? label.top : '';
        el.price.style.fontSize = label && label.fontSize ? `${label.fontSize}rem` : '';
    }

    function render(state) {
        if (!state) return;
        const first = current === null;
        const prev = current || {};
        current = state;

        setText(el.time, state.remaining || '00:00:00');
        setText(el.stopwatch, state.stopwatchText || '');
        setText(el.price, state.priceText || '');
        setText(el.goalText, state.goalText || '');
        el.goalFill.style.width = `${Number(state.goalPercentage) || 0}%`;

        toggle('show-stopwatch', state.showStopwatch);
        toggle('show-price', state.showRubPerHour);
        toggle('goal-active', state.isGoalActive);
        toggle('sleep', state.sleepModeEnabled);

        if (first || prev.isPause !== state.isPause) applyPause(state.isPause, first);
        if (first || JSON.stringify(prev.rubLabel) !== JSON.stringify(state.rubLabel)) applyPriceLabel(state.rubLabel);
    }

    function formatAdded(seconds) {
        const sign = seconds > 0 ? '+' : '−';
        return `${sign}${Math.abs(seconds).toFixed(3).replace(/\.?0+$/, '')}s`;
    }

    const randomInRange = (min, max) => Math.floor(Math.random() * (max - min)) + min;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    async function showAdded(seconds) {
        const node = document.createElement('p');
        node.className = 'addedTime';
        node.textContent = formatAdded(seconds);
        node.style.left = `${randomInRange(35, 65)}%`;
        node.style.top = `${randomInRange(35, 65)}%`;
        document.body.appendChild(node);
        await wait(50);
        node.style.top = `${randomInRange(15, 60)}%`;
        node.style.opacity = '1';
        await wait(2500);
        node.style.opacity = '0';
        await wait(500);
        node.remove();
    }

    function playGoalSound() {
        if (!isWindow) return;
        const audio = new Audio('media/goal_success.mp3');
        audio.play().catch(() => {});
    }

    function handleEvent(event) {
        if (!event) return;
        if (event.type === 'addTime' && Number.isFinite(event.seconds)) showAdded(event.seconds);
        else if (event.type === 'goalSuccess') playGoalSound();
    }

    function startWindowMode() {
        bridge.onState(render);
        bridge.onEvent(handleEvent);
        bridge.getState().then(render);

        const keyCommands = {
            ArrowUp: (e) => (e.shiftKey ? 'addLarge' : 'addSmall'),
            ArrowDown: (e) => (e.shiftKey ? 'subtractLarge' : 'subtractSmall'),
            KeyR: () => 'reset',
            Space: () => 'togglePause'
        };

        document.addEventListener('keydown', (e) => {
            if (e.repeat && e.code !== 'ArrowUp' && e.code !== 'ArrowDown') return;
            if (e.code === 'KeyO') {
                e.preventDefault();
                bridge.toggleControl();
                return;
            }
            const resolve = keyCommands[e.code];
            if (!resolve) return;
            e.preventDefault();
            bridge.command(resolve(e));
        });

        let startX = 0;
        let startY = 0;
        let initialLeft = 0;
        let initialTop = 0;

        const currentFontSize = () => {
            const label = current && current.rubLabel;
            return label && label.fontSize ? label.fontSize : DEFAULT_PRICE_FONT_SIZE;
        };

        function saveLabel(patch) {
            const label = Object.assign({}, current && current.rubLabel, patch);
            if (current) current = Object.assign({}, current, {rubLabel: label});
            bridge.setPriceLabel(label);
        }

        el.price.addEventListener('mousedown', (e) => {
            dragging = true;
            const rect = el.price.getBoundingClientRect();
            const parentRect = el.container.getBoundingClientRect();
            if (!el.price.classList.contains('positioned')) {
                el.price.style.left = `${rect.left - parentRect.left}px`;
                el.price.style.top = `${rect.top - parentRect.top}px`;
                el.price.classList.add('positioned');
            }
            startX = e.clientX;
            startY = e.clientY;
            initialLeft = parseFloat(el.price.style.left) || 0;
            initialTop = parseFloat(el.price.style.top) || 0;
            el.price.classList.add('dragging');
        });

        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            el.price.style.left = `${initialLeft + e.clientX - startX}px`;
            el.price.style.top = `${initialTop + e.clientY - startY}px`;
        });

        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            el.price.classList.remove('dragging');
            saveLabel({left: el.price.style.left, top: el.price.style.top});
        });

        el.price.addEventListener('wheel', (e) => {
            e.preventDefault();
            const size = Math.max(MIN_PRICE_FONT_SIZE, currentFontSize() + (e.deltaY < 0 ? PRICE_FONT_STEP : -PRICE_FONT_STEP));
            const rounded = Math.round(size * 10) / 10;
            el.price.style.fontSize = `${rounded}rem`;
            saveLabel({fontSize: rounded});
        }, {passive: false});
    }

    function startOverlayMode() {
        fetch('./state', {cache: 'no-store'})
            .then((r) => (r.ok ? r.json() : null))
            .then((state) => {
                if (state && current === null) render(state);
            })
            .catch(() => {})
            .finally(connectEvents);

        function connectEvents() {
            const source = new EventSource('./sse');
            source.onmessage = (e) => {
                let msg;
                try {
                    msg = JSON.parse(e.data);
                } catch {
                    return;
                }
                if ((msg.type === 'tick' || msg.type === 'bootstrap') && msg.state) render(msg.state);
                else if (msg.type === 'event') handleEvent(msg.event);
            };
            source.onerror = () => {
                source.close();
                setTimeout(connectEvents, 3000);
            };
        }
    }

    if (isWindow) startWindowMode();
    else startOverlayMode();
})();
