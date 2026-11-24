const pad2 = (n) => {
    const s = n.toString();
    return (s.length < 2) ? `0${s}` : s;
};

timeFunc = {
    addHours(time, h) {
        time.setTime(time.getTime() + (h * 60 * 60 * 1000));
        return time;
    },

    addMinutes(time, m) {
        time.setTime(time.getTime() + (m * 60 * 1000));
        return time;
    },

    addSeconds(time, s) {
        time.setTime(time.getTime() + (s * 1000));
        return time;
    },

    getHours(time) {
        return pad2(Math.floor(time / (1000 * 60 * 60)));
    },

    getMinutes(time) {
        return pad2(Math.floor((time % (1000 * 60 * 60)) / (1000 * 60)));
    },

    getSeconds(time) {
        return pad2(Math.floor((time % (1000 * 60)) / 1000));
    }
};