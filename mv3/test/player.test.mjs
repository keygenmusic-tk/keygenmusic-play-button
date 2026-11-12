import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';

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
    let now = 1000;
    let audio;
    class Audio extends EventTarget {
        readyState = 4;
        ended = false;
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
        Date: {now: () => now},
        performance: {now: () => now},
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
        const source = readFileSync(new URL('../src/' + file, import.meta.url), 'utf8')
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
        advanceTime: msec => { now += msec; },
        expireTimer: async delay => {
            assert.equal(timers.size, 1);
            const [id, timer] = timers.entries().next().value;
            assert.equal(timer.delay, delay);
            timers.delete(id);
            now += delay;
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

test('track transitions exclude loading time and report each listening interval once', async () => {
    const pending = deferred();
    const h = createPlayer({play: count => count === 2 ? pending.promise : Promise.resolve()});
    await h.player.play();
    h.advanceTime(10000);
    h.audio.dispatchEvent(new Event('ended'));
    await flush();
    h.advanceTime(5000);
    pending.resolve();
    await flush();
    assert.equal(h.events[1].playedMsec, 10000);
    h.advanceTime(2000);
    h.player.stop();
    assert.equal(h.events[2].playedMsec, 2000);
    h.player.stop();
    assert.equal(h.events[3].playedMsec, 0);
});

test('stopping during next-track loading preserves prior playback without counting the wait', async () => {
    const h = createPlayer({play: count => count === 2 ? new Promise(() => {}) : Promise.resolve()});
    await h.player.play();
    h.advanceTime(10000);
    h.player.next();
    await flush();
    h.advanceTime(5000);
    h.player.stop();
    await flush();
    assert.equal(h.events.at(-1).playedMsec, 10000);
});

test('buffering gaps are excluded and repeated media events do not duplicate time', async () => {
    const h = createPlayer();
    await h.player.play();
    h.advanceTime(10000);
    h.audio.readyState = 2;
    h.audio.dispatchEvent(new Event('waiting'));
    h.advanceTime(20000);
    h.audio.dispatchEvent(new Event('waiting'));
    h.audio.readyState = 4;
    h.audio.dispatchEvent(new Event('playing'));
    h.advanceTime(3000);
    h.audio.dispatchEvent(new Event('playing'));
    h.advanceTime(2000);
    h.player.stop();
    assert.equal(h.events.at(-1).playedMsec, 15000);
});

test('pauses exclude silence while network stalls with buffered audio still count', async () => {
    const h = createPlayer();
    await h.player.play();
    h.advanceTime(5000);
    h.audio.pause();
    h.audio.dispatchEvent(new Event('pause'));
    h.advanceTime(20000);
    await h.audio.play();
    h.audio.dispatchEvent(new Event('playing'));
    // Ignore an old pause notification now that audio has resumed.
    h.audio.dispatchEvent(new Event('pause'));
    h.audio.dispatchEvent(new Event('stalled'));
    h.advanceTime(5000);
    h.player.stop();
    assert.equal(h.events.at(-1).playedMsec, 10000);
});

test('mirror exhaustion retains listening time and excludes all retry delays', async () => {
    const h = createPlayer({play: count => count === 1 ? Promise.resolve() : new Promise(() => {})});
    await h.player.play();
    h.advanceTime(10000);
    h.player.next();
    await flush();
    await h.expireTimer(10000);
    await h.expireTimer(10000);
    assert.equal(h.events.at(-1).type, 'stop');
    assert.equal(h.events.at(-1).playedMsec, 10000);
});

test('initial loading and cancelled startup never contribute listening time', async () => {
    const h = createPlayer({play: () => new Promise(() => {})});
    h.player.play();
    await flush();
    h.advanceTime(5000);
    h.player.stop();
    // Late playback notifications after cancellation must not restart accounting.
    h.audio.dispatchEvent(new Event('playing'));
    h.advanceTime(5000);
    h.player.stop();
    assert.deepEqual(h.events.map(event => event.playedMsec), [0, 0]);
    await flush();
});
