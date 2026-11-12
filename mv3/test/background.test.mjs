import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';

const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return {promise, resolve};
};

const createBackground = ({startupGate, mirrorGate, failMirrorWrite = false} = {}) => {
    const local = {TOTAL_PLAYED: 0};
    const session = {flag: startupGate ? 0 : 1};
    const toolbar = {badge: '', title: ''};
    const errors = [];
    const mirrorWriteStarted = deferred();
    let onMessage;
    const chrome = {
        storage: {
            local: {
                get: async defaults => ({...defaults, ...local}),
                set: async values => { Object.assign(local, values); },
            },
            session: {
                get: async () => {
                    if (startupGate) await startupGate.promise;
                    return {...session};
                },
                set: async values => {
                    if ('LAST_WORKING_MIRROR' in values) {
                        mirrorWriteStarted.resolve();
                        if (failMirrorWrite) throw new Error('Storage unavailable');
                        if (mirrorGate) await mirrorGate.promise;
                    }
                    Object.assign(session, values);
                },
            },
        },
        action: {
            onClicked: {addListener() {}},
            setBadgeTextColor: async () => {},
            setBadgeBackgroundColor: async () => {},
            setBadgeText: async ({text}) => { toolbar.badge = text; },
            setTitle: async ({title}) => { toolbar.title = title; },
        },
        alarms: {onAlarm: {addListener() {}}},
        runtime: {onMessage: {addListener: listener => { onMessage = listener; }}},
        i18n: {getMessage: key => key},
    };
    const context = vm.createContext({
        chrome,
        console: {log: (...args) => errors.push(args)},
        enableAlarm: async () => {},
    });
    // Load the source without its bundler-resolved imports; use real constants/helpers.
    for (const file of ['consts.js', 'utils/utils.js', 'background/background.js']) {
        const source = readFileSync(new URL('../src/' + file, import.meta.url), 'utf8')
            .replace(/^import .*;\r?\n/gm, '')
            .replace(/^export /gm, '');
        vm.runInContext(source, context, {filename: file});
    }
    return {
        local, toolbar, errors, mirrorWriteStarted,
        send: message => onMessage(message),
        flush: () => vm.runInContext('playbackUpdates', context),
    };
};

const play = (playedMsec = 0) => ({
    cmd: 'PLAY',
    data: {mirror: 'https://static.kgm.pp.ua/mp3/', info: 'Track', playedMsec},
});
const stop = playedMsec => ({cmd: 'STOP', data: {playedMsec}});
const playbackState = state => ({cmd: 'PLAYBACK_STATE', data: {state, info: 'Track'}});

test('a delayed PLAY cannot overwrite a newer STOP', async () => {
    const mirrorGate = deferred();
    const bg = createBackground({mirrorGate});
    bg.send(play());
    await bg.mirrorWriteStarted.promise;
    bg.send(stop(1000));
    mirrorGate.resolve();
    await bg.flush();
    assert.equal(bg.toolbar.badge, '');
    assert.equal(bg.toolbar.title, 'p_totalPlayed 0p_hour 0p_min');
    assert.equal(bg.local.TOTAL_PLAYED, 1000);
});

test('overlapping playback messages preserve every statistics increment', async () => {
    const bg = createBackground();
    bg.send(play(1000));
    bg.send(stop(2000));
    bg.send(play(3000));
    await bg.flush();
    assert.equal(bg.local.TOTAL_PLAYED, 6000);
    assert.equal(bg.toolbar.badge, ' ▶');
    assert.equal(bg.toolbar.title, 'p_nowPlaying\nTrack');
});

test('a failed update does not block subsequent messages', async () => {
    const bg = createBackground({failMirrorWrite: true});
    bg.send(play());
    bg.send(stop(2000));
    await bg.flush();
    assert.equal(bg.errors.length, 1);
    assert.equal(bg.local.TOTAL_PLAYED, 2000);
    assert.equal(bg.toolbar.badge, '');
});

test('startup tooltip initialization cannot overwrite playback', async () => {
    const startupGate = deferred();
    const bg = createBackground({startupGate});
    bg.send(play());
    startupGate.resolve();
    await bg.flush();
    assert.equal(bg.toolbar.title, 'p_nowPlaying\nTrack');
    assert.equal(bg.toolbar.badge, ' ▶');
});

test('buffering and resume update the toolbar without adding listening time', async () => {
    const bg = createBackground();
    bg.send(play(1000));
    bg.send(playbackState('loading'));
    await bg.flush();
    assert.equal(bg.toolbar.badge, '...');
    assert.equal(bg.toolbar.title, 'p_loading\nTrack');
    assert.equal(bg.local.TOTAL_PLAYED, 1000);
    bg.send(playbackState('playing'));
    await bg.flush();
    assert.equal(bg.toolbar.badge, ' ▶');
    assert.equal(bg.toolbar.title, 'p_nowPlaying\nTrack');
    assert.equal(bg.local.TOTAL_PLAYED, 1000);
});

test('a delayed PLAY cannot overwrite a newer buffering update', async () => {
    const mirrorGate = deferred();
    const bg = createBackground({mirrorGate});
    bg.send(play());
    await bg.mirrorWriteStarted.promise;
    bg.send(playbackState('loading'));
    mirrorGate.resolve();
    await bg.flush();
    assert.equal(bg.toolbar.badge, '...');
    assert.equal(bg.toolbar.title, 'p_loading\nTrack');
});

test('stopping after a buffering notification clears the loading badge', async () => {
    const bg = createBackground();
    bg.send(playbackState('loading'));
    bg.send(stop(1000));
    await bg.flush();
    assert.equal(bg.toolbar.badge, '');
    assert.equal(bg.toolbar.title, 'p_totalPlayed 0p_hour 0p_min');
    assert.equal(bg.local.TOTAL_PLAYED, 1000);
});
