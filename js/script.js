const {ipcRenderer} = require('electron');
const path = require('path');
const {writeFileAtomic, readTextFile, removeFile} = require(path.join(__dirname, 'js/lib/storage.js'));

const {timer: timerFilePath, stopwatch: stopwatchFilePath} = ipcRenderer.sendSync('storage:paths-sync');
let priceSettings = null;

let endingTime = new Date(Date.now());
let pauseTime = 0;

let sleepSlowOffsetMs = 0;
let sleepLastTickMs = Date.now();
const sleepGetScale = () => (window.sleepModeEnabled ? 0.5 : 1.0);
window.addEventListener('sleepModeMaybeChanged', () => {
    sleepLastTickMs = Date.now();
});

let countdownEnded = false;
let lastSavedTime = "";
const rubPerHourText = document.getElementById("rubPerHourText");
let showRubPerHour = true;

let elapsedSeconds = 0;
let showStopwatchState = false;

let visibilityTimeout;
let hideTimeout;

const SHOW_DURATION = 15000;
const THREE_DAYS_IN_SECONDS = 3 * 24 * 3600; // 259200 секунд

let lastPriceTier = -1;

let isGoalActive = false;
let goalTargetHours = 0;
let goalTargetAmount = 0;
let goalCurrentAmount = 0;

const goalContainer = document.getElementById('goalContainer');
const goalText = document.getElementById('goalText');
const goalBarFill = document.getElementById('goalBarFill');

const stopwatchEl = document.getElementById("stopwatchText");
const timeTextEl = document.getElementById("timeText");
const pauseIconElement = document.getElementById("pauseIcon");


function formatStopwatch(totalSeconds) {
    const d = Math.floor(totalSeconds / (3600 * 24));
    const h = Math.floor((totalSeconds % (3600 * 24)) / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;

    return `прошло ${d} д ${h} ч ${m} м ${s} с`;
}

if (timeTextEl) {
    timeTextEl.style.transition = 'font-size 0.5s ease';
}

function showStopwatch() {
    if (!stopwatchEl) return;

    stopwatchEl.innerText = formatStopwatch(elapsedSeconds);
    stopwatchEl.style.opacity = '1';
    stopwatchEl.style.fontSize = '1.5rem';
    stopwatchEl.style.transform = 'translate(-50%, -20%)';

    if (timeTextEl) {
        timeTextEl.style.fontSize = '3.8rem';
        timeTextEl.style.transform = 'translate(0, -18%)';
    }
}

function hideStopwatch() {
    if (!stopwatchEl) return;

    stopwatchEl.style.opacity = '0';
    stopwatchEl.style.fontSize = '0.85rem';
    stopwatchEl.style.transform = 'translate(-50%, -20px)';

    if (timeTextEl) {
        timeTextEl.style.fontSize = '5rem';
        timeTextEl.style.transform = 'translate(0, 0)';
    }
}

function updateRubPerHourUI() {
    if (rubPerHourText) {
        const priceFor3Min = Math.round(rublesPerHour / 20);
        rubPerHourText.innerText = `${priceFor3Min}р = 3 минуты`;
        rubPerHourText.style.display = showRubPerHour ? "block" : "none";
    }
}

ipcRenderer.on('settings:update', (_e, s) => {
    if (!s) return;

    priceSettings = {
        dynamicPriceIncreaseEnabled: !!s.dynamicPriceIncreaseEnabled,
        baseRubPerHour: Number(s.baseRubPerHour),
        dynamicPriceStep: Number(s.dynamicPriceStep)
    };

    let priceChanged = false;
    if (typeof s.secondsAddedPerCurrency !== 'undefined' && s.secondsAddedPerCurrency > 0) {
        const newRublesPerHour = Math.round(3600 / s.secondsAddedPerCurrency);
        if (newRublesPerHour !== rublesPerHour) {
            rublesPerHour = newRublesPerHour;
            priceChanged = true;
        }
    }

    if (typeof s.showRubPerHour !== 'undefined') {
        showRubPerHour = s.showRubPerHour;
    }
    if (typeof s.dynamicPriceIncreaseEnabled !== 'undefined') window.dynamicPriceIncreaseEnabled = s.dynamicPriceIncreaseEnabled;
    if (typeof s.maxTimerTier !== 'undefined') window.maxTimerTier = s.maxTimerTier;
    if (typeof s.sleepModeEnabled !== 'undefined') {
        const sleepMoon = document.getElementById('sleepMoon');
        if (sleepMoon) {
            sleepMoon.style.opacity = s.sleepModeEnabled ? "1" : "0";
        }
    }

    if (priceChanged && isGoalActive) {
        goalTargetAmount = goalTargetHours * rublesPerHour;
        updateGoalUI();
    }

    updateRubPerHourUI();
    checkPriceTiers();
});

function scheduleStopwatchVisibility() {
    if (countdownEnded) return;

    const nextInterval = randomInRange(30 * 60 * 1000, 60 * 60 * 1000);

    visibilityTimeout = setTimeout(() => {
        if (countdownEnded) return;

        showStopwatchState = true;

        hideTimeout = setTimeout(() => {
            if (countdownEnded) return;

            showStopwatchState = false;
            hideStopwatch();

            scheduleStopwatchVisibility();
        }, SHOW_DURATION);

    }, nextInterval);
}

const resetTime = (isStartup = false) => {
    endingTime = new Date(new Date(Date.now()) - pauseTime);
    endingTime = timeFunc.addHours(endingTime, initialHours);
    endingTime = timeFunc.addMinutes(endingTime, initialMinutes);
    endingTime = timeFunc.addSeconds(endingTime, initialSeconds);
    countdownEnded = false;

    if (!isStartup) {
        elapsedSeconds = 0;
        showStopwatchState = false;
        window.maxTimerTier = 0;
        lastPriceTier = 0;
        ipcRenderer.send('settings:set', {
            maxTimerTier: 0,
            secondsAddedPerCurrency: 3.6
        });
    }
    hideStopwatch();
    clearTimeout(visibilityTimeout);
    clearTimeout(hideTimeout);
    scheduleStopwatchVisibility();
}

updateRubPerHourUI()
resetTime(true);
clearTimeout(visibilityTimeout);
clearTimeout(hideTimeout);
showStopwatchState = true;
showStopwatch()

try {
    const savedTimeStr = (readTextFile(timerFilePath) || '').trim();
    if (savedTimeStr) {
        const parts = savedTimeStr.split(':');

        if (parts.length === 3) {
            const h = parseInt(parts[0], 10);
            const m = parseInt(parts[1], 10);
            const s = parseInt(parts[2], 10);

            if (!isNaN(h) && !isNaN(m) && !isNaN(s)) {
                const savedMs = ((h * 60 + m) * 60 + s) * 1000;
                const now = new Date(Date.now());
                let currentTime = now - (pauseTime + sleepSlowOffsetMs);

                endingTime = new Date(currentTime + savedMs);
            }
        }
    }
} catch (err) {
    console.error("Ошибка чтения файла таймера:", err);
}

try {
    const savedData = (readTextFile(stopwatchFilePath) || '').trim();
    if (savedData) {
        elapsedSeconds = parseInt(savedData, 10) || 0;
        lastPriceTier = Math.floor(elapsedSeconds / THREE_DAYS_IN_SECONDS);
    }
} catch (e) {
    console.error("Ошибка чтения файла секундомера:", e);
}

if (isGreenBackground) {
    document.body.style.backgroundColor = '#00ff00';
}

let time;
let isPause = true;
let prevPauseDate = new Date(Date.now());

setInterval(() => {
    if (!isPause && !countdownEnded && window.donationModeEnabled) {
        elapsedSeconds++;
        try {
            writeFileAtomic(stopwatchFilePath, elapsedSeconds.toString());
        } catch (e) {
        }
        const currentPriceTier = Math.floor(elapsedSeconds / THREE_DAYS_IN_SECONDS);
        if (lastPriceTier === -1) {
            lastPriceTier = currentPriceTier;
        } else if (currentPriceTier > lastPriceTier) {
            lastPriceTier = currentPriceTier;
            checkPriceTiers();
        }
    }

    if (countdownEnded) {
        if (window.donationModeEnabled) {
            showStopwatch();
        } else {
            hideStopwatch();
        }

        try {
            removeFile(stopwatchFilePath);
        } catch (e) {
        }
    } else {
        if (showStopwatchState && window.donationModeEnabled) {
            showStopwatch();
        } else {
            hideStopwatch();
        }
    }
}, 1000);

function checkPriceTiers() {
    if (!priceSettings || !priceSettings.dynamicPriceIncreaseEnabled) return;

    const swTiers = lastPriceTier > 0 ? lastPriceTier : 0;
    const tmTiers = window.maxTimerTier || 0;

    const highestTier = Math.max(swTiers, tmTiers);

    const basePrice = priceSettings.baseRubPerHour || 1000;
    const stepPrice = priceSettings.dynamicPriceStep || 1000;

    const expectedRubPerHour = basePrice + (highestTier * stepPrice);

    if (expectedRubPerHour !== rublesPerHour) {
        ipcRenderer.send('settings:set', {
            maxTimerTier: tmTiers,
            secondsAddedPerCurrency: 3600 / expectedRubPerHour
        });
    }
}

ipcRenderer.on('goal:activate', (_e, data) => {
    goalTargetHours = data.hours;
    goalTargetAmount = goalTargetHours * rublesPerHour;
    goalCurrentAmount = 0;
    isGoalActive = true;

    goalText.innerText = `Сбор: 0 / ${Math.round(goalTargetAmount)} руб. (${goalTargetHours}ч)`;
    goalBarFill.style.width = '0%';
    goalContainer.style.transform = "translateX(-50%) translateY(-350%)";
    goalContainer.style.opacity = "1";
});

ipcRenderer.on('goal:deactivate', () => {
    closeGoalUI();
});

function closeGoalUI() {
    isGoalActive = false;
    goalContainer.style.transform = "translateX(-50%) translateY(-200%)";
    goalContainer.style.opacity = "0";
    ipcRenderer.send('goal:ended');
}

function updateGoalUI() {
    goalText.innerText = `Сбор: ${Math.round(goalCurrentAmount)} / ${Math.round(goalTargetAmount)} руб. (${goalTargetHours}ч)`;
    const percentage = Math.min((goalCurrentAmount / goalTargetAmount) * 100, 100);
    goalBarFill.style.width = `${percentage}%`;
}

function successGoal() {
    const audio = new Audio('media/goal_success.mp3');
    audio.play().catch(e => console.error("Не удалось воспроизвести звук сбора:", e));

    addTime(goalTargetHours * 3600);

    closeGoalUI();
}

function handleDonationWithGoalSystem(rubles) {
    if (!isGoalActive) {
        addTime(rubles * secondsAddedPerCurrency);
        return;
    }

    const remainingToFill = goalTargetAmount - goalCurrentAmount;

    if (rubles <= remainingToFill) {
        goalCurrentAmount += rubles;
        updateGoalUI();

        if (goalCurrentAmount >= goalTargetAmount) {
            successGoal();
        }
    } else {
        const excessRubles = rubles - remainingToFill;
        goalCurrentAmount = goalTargetAmount;
        updateGoalUI();
        successGoal();

        addTime(excessRubles * secondsAddedPerCurrency);
    }
}

const getNextTime = () => {
    const now = new Date(Date.now());
    if (!isPause) {
        const nowMs = now.getTime();
        const delta = nowMs - (sleepLastTickMs || nowMs);
        const scale = sleepGetScale();
        if (scale < 1) {
            sleepSlowOffsetMs += (1 - scale) * delta;
        }
        sleepLastTickMs = nowMs;
    } else {
        sleepLastTickMs = now.getTime();
    }

    if (isPause && prevPauseDate) {
        const cur = now;
        pauseTime += now - prevPauseDate;
        prevPauseDate = cur;
    }

    let currentTime = now - (pauseTime + sleepSlowOffsetMs);
    let differenceTime = endingTime - currentTime;

    if (differenceTime > 0) {
        const timerSeconds = Math.floor(differenceTime / 1000);
        const currentTimerTier = Math.floor(timerSeconds / THREE_DAYS_IN_SECONDS);

        if (currentTimerTier > window.maxTimerTier) {
            window.maxTimerTier = currentTimerTier;
            checkPriceTiers();
        }
    }

    time = `${timeFunc.getHours(differenceTime)}:${timeFunc.getMinutes(differenceTime)}:${timeFunc.getSeconds(differenceTime)}`;

    if (differenceTime > 0 && time !== lastSavedTime) {
        try {
            writeFileAtomic(timerFilePath, time);
            lastSavedTime = time;
        } catch (err) {
        }
    }

    if (differenceTime <= 0) {
        if (canIncreaseTimeAfterStop) {
            endingTime = new Date(currentTime);
        } else {
            if (!countdownEnded) {
                countdownEnded = true;
                if (isGoalActive) {
                    closeGoalUI();
                }
                window.maxTimerTier = 0;

                ipcRenderer.send('settings:set', {
                    maxTimerTier: 0
                });
            }
        }
        time = "00:00:00";

        try {
            removeFile(timerFilePath);
        } catch (err) {
        }
    }

    timeTextEl.innerText = time;

    const shouldShowStopwatch = countdownEnded
        ? window.donationModeEnabled
        : (showStopwatchState && window.donationModeEnabled);

    ipcRenderer.send('overlay:state', {
        remaining: time,
        rublesPerHour: rublesPerHour,
        showRubPerHour: showRubPerHour,
        stopwatchText: formatStopwatch(elapsedSeconds),
        showStopwatch: shouldShowStopwatch,
        isGoalActive: isGoalActive,
        goalText: isGoalActive ? goalText.innerText : "Сбор: 0 / 0 руб",
        goalPercentage: isGoalActive ? Math.min((goalCurrentAmount / goalTargetAmount) * 100, 100) : 0,
        isPause: isPause,
        sleepModeEnabled: window.sleepModeEnabled
    });

    requestAnimationFrame(getNextTime);
};

requestAnimationFrame(getNextTime);

const addTime = async (s) => {
    if (countdownEnded && !canIncreaseTimeAfterStop) return;

    endingTime = timeFunc.addSeconds(endingTime, s);

    ipcRenderer.send('overlay:event', {
        type: 'addTime',
        seconds: s
    });

    let addedTime = document.createElement("p");
    addedTime.className = "addedTime";
    addedTime.innerText = `${s > 0 ? '+' : ''}${s.toString().split('.')[0]}${s.toString().split('.')[1] ? '.' + s.toString().split('.')[1].slice(0, 3) : ''}s`;
    document.body.appendChild(addedTime);
    addedTime.style.display = "block";
    await sleep(50);
    addedTime.style.left = `${randomInRange(35, 65)}%`;
    addedTime.style.top = `${randomInRange(15, 60)}%`;
    addedTime.style.opacity = "1";
    await sleep(2500);
    addedTime.style.opacity = "0";
    await sleep(500);
    addedTime.remove();
};

document.addEventListener("keydown", (e) => {
    switch (e.code) {
        case "ArrowUp":
            if (e.shiftKey) {
                addTime(timeIncrease);
                return;
            }
            addTime(timeMinuteIncDec)
            return
        case "ArrowDown":
            if (e.shiftKey) {
                addTime(-timeDecrease);
                return;
            }
            addTime(-timeMinuteIncDec)
            return
        case "KeyR":
            resetTime();
            return;
        case "Space":
            prevPauseDate = isPause ? null : new Date(Date.now());
            isPause = !isPause;
            if (window.pauseIconTimeout) {
                clearTimeout(window.pauseIconTimeout);
            }

            if (isPause) {
                window.pauseIconTimeout = setTimeout(() => {
                    pauseIconElement.style.opacity = "1";
                }, 700);
            } else {
                pauseIconElement.style.opacity = "0";
            }

            if (isPause && window.donationModeEnabled) {
                clearTimeout(visibilityTimeout);
                clearTimeout(hideTimeout);
                showStopwatchState = true;
            } else if (window.donationModeEnabled) {
                showStopwatchState = false;
                clearTimeout(visibilityTimeout);
                clearTimeout(hideTimeout);
                scheduleStopwatchVisibility();
            }
            return;
        case "KeyO":
            ipcRenderer.send('control:toggle');
            return;
    }
});