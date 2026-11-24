const sleep = (ms) => {
    return new Promise(resolve => setTimeout(resolve, ms));
};

const randomInRange = (min, max) => {
    return Math.floor(Math.random() * (max - min)) + min;
};