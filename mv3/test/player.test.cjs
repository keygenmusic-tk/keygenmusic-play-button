const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const vm = require('node:vm');

const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return {promise, resolve, reject};
};

const createPlayer = ({play, fetch} = {}) => {
    const timers = new Map();
    const requests = [];
    const events = [];
    let nextTimerId = 0;
    let playCount = 0;
    let audio;
    class Audio extends EventTarget {
        constructor() {
            super();
            audio = this;
        }
        pause() { this.paused = true; }
        play() {
            this.paused = false;
            return play ? play(++playCount, this) : Promise.resolve();
        }
    }
    const context = vm.createContext({
        Audio, EventTarget, Event, CustomEvent, AbortController, DOMException,
        navigator: {},
        setTimeout: (callback, delay) => {
            const id = ++nextTimerId;
            timers.set(id, {callback, delay});
            return id;
        },
        clearTimeout: id => timers.delete(id),
        fetch: (url, options) => {
            requests.push({url, signal: options.signal});
            return fetch ? fetch(requests.length) : Promise.resolve({ok: true});
        },
    });
    for (const file of ['utils/utils.js', 'offscreen/Player.js']) {
        const source = readFileSync(path.join(__dirname, '../src', file), 'utf8')
            .replace(/^import .*;\r?\n/gm, '')
            .replace(/^export /gm, '');
        vm.runInContext(source, context, {filename: file});
    }
    const player = vm.runInContext(
        "new Player([{p: 'track.mp3', st: 'Track'}], ['https://first/', 'https://second/'])",
        context,
    );
    for (const type of ['play', 'stop']) {
        player.addEventListener(type, event => events.push({type, ...event.detail}));
    }
    return {
        player, audio, requests, events, timers,
        expireTimer: async delay => {
            assert.equal(timers.size, 1);
            const [id, timer] = timers.entries().next().value;
            assert.equal(timer.delay, delay);
            timers.delete(id);
            timer.callback();
            await flush();
        },
    };
};

test('stalled audio startup falls back and ignores late completion', async () => {
    const first = deferred();
    const h = createPlayer({play: count => count === 1 ? first.promise : Promise.resolve()});
    h.player.play();
    await flush();
    assert.equal(h.player.isLoading, true);
    await h.expireTimer(10000);
    assert.equal(h.requests.length, 2);
    assert.equal(h.events[0].mirror, 'https://second/');
    assert.equal(h.player.isPlaying, true);
    assert.equal(h.player.isLoading, false);
    assert.equal(h.timers.size, 0);
    first.resolve();
    await flush();
    assert.equal(h.events.length, 1);
});

test('exhausting stalled mirrors stops playback and clears timers', async () => {
    const h = createPlayer({play: () => new Promise(() => {})});
    h.player.play();
    await flush();
    await h.expireTimer(10000);
    await h.expireTimer(10000);
    assert.equal(h.requests.length, 2);
    assert.deepEqual(h.events.map(event => event.type), ['stop']);
    assert.equal(h.player.isLoading, false);
    assert.equal(h.player.isPlaying, false);
    assert.equal(h.audio.paused, true);
    assert.equal(h.timers.size, 0);
});

test('a media error and play rejection trigger only one fallback', async () => {
    const h = createPlayer({play: (count, audio) => {
        if (count === 1) {
            audio.dispatchEvent(new Event('error'));
            return Promise.reject(new DOMException('Cannot decode', 'NotSupportedError'));
        }
        return Promise.resolve();
    }});
    h.player.play();
    await flush();
    assert.equal(h.requests.length, 2);
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].mirror, 'https://second/');
    assert.equal(h.player.isPlaying, true);
    assert.equal(h.timers.size, 0);
});

test('stalled HEAD requests still time out after three seconds', async () => {
    const h = createPlayer({fetch: count => count === 1
        ? new Promise(() => {}) : Promise.resolve({ok: true})});
    h.player.play();
    await h.expireTimer(3000);
    assert.equal(h.requests[0].signal.aborted, true);
    assert.equal(h.events[0].mirror, 'https://second/');
    assert.equal(h.timers.size, 0);
});

test('HTTP failures skip audio startup on the failed mirror', async () => {
    const h = createPlayer({fetch: count => Promise.resolve({ok: count > 1, status: 503})});
    h.player.play();
    await flush();
    assert.equal(h.requests.length, 2);
    assert.equal(h.audio.src, 'https://second/track.mp3');
    assert.equal(h.events[0].mirror, 'https://second/');
    assert.equal(h.timers.size, 0);
});

test('stopping pending audio cancels the deadline without trying another mirror', async () => {
    const pending = deferred();
    const h = createPlayer({play: () => pending.promise});
    const attempt = h.player.play();
    await flush();
    h.player.stop();
    await attempt;
    assert.equal(h.timers.size, 0);
    pending.resolve();
    await flush();
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.events.map(event => event.type), ['stop']);
    assert.equal(h.player.isPlaying, false);
    assert.equal(h.audio.paused, true);
});

test('replacing pending audio ignores rejection from the old attempt', async () => {
    const pending = deferred();
    const h = createPlayer({play: count => count === 1 ? pending.promise : Promise.resolve()});
    const firstAttempt = h.player.play();
    await flush();
    await h.player.play();
    await firstAttempt;
    pending.reject(new DOMException('Interrupted', 'AbortError'));
    await flush();
    assert.equal(h.requests.length, 2);
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].mirror, 'https://first/');
    assert.equal(h.player.isPlaying, true);
    assert.equal(h.timers.size, 0);
});

test('media errors after startup still fall back to another mirror', async () => {
    const h = createPlayer();
    await h.player.play();
    assert.equal(h.timers.size, 0);
    h.audio.dispatchEvent(new Event('error'));
    await flush();
    assert.equal(h.events.length, 2);
    assert.equal(h.events[1].mirror, 'https://second/');
    assert.equal(h.player.isPlaying, true);
    assert.equal(h.timers.size, 0);
});
