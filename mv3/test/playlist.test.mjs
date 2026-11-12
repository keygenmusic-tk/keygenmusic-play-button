import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';

const validList = [
    {p: '!Others/Track 120%25.mp3', st: 'Track 120%'},
    {p: 'Group/Музика.mp3', st: 'Музика'},
];
const invalidLists = [
    null, [], 'unavailable', {length: 1}, new Array(1),
    [null], [42], ['track.mp3'], [[]], [{}],
    [{p: 'track.mp3'}], [{st: 'Track'}],
    [{p: 42, st: 'Track'}], [{p: '', st: 'Track'}], [{p: ' \t', st: 'Track'}],
    [{p: 'track.mp3', st: 42}], [{p: 'track.mp3', st: ''}], [{p: 'track.mp3', st: ' \n'}],
    [validList[0], null],
];

const createPlaylist = ({cached = null, responses = [validList]} = {}) => {
    const local = {list: cached, TOTAL_PLAYED: 1234};
    const requests = [];
    const writes = [];
    const context = vm.createContext({
        AbortSignal,
        chrome: {storage: {local: {
            get: async () => ({...local}),
            set: async values => {
                writes.push(values);
                Object.assign(local, values);
            },
        }}},
        fetch: async url => {
            const response = responses[requests.length];
            requests.push(url);
            if (response instanceof Error) throw response;
            return {ok: true, json: async () => response};
        },
    });
    for (const file of ['consts.js', 'background/playlist.js']) {
        const source = readFileSync(new URL('../src/' + file, import.meta.url), 'utf8')
            .replace(/^import .*;\r?\n/gm, '')
            .replace(/^export /gm, '');
        vm.runInContext(source, context, {filename: file});
    }
    return {
        local, requests, writes,
        getPlaylist: vm.runInContext('getPlaylist', context),
        refresh: vm.runInContext('fetchAndUpdateList', context),
    };
};

test('a valid cached playlist is reused without downloading or rewriting it', async () => {
    const h = createPlaylist({cached: validList});
    assert.deepEqual(await h.getPlaylist(), validList);
    assert.equal(h.requests.length, 0);
    assert.equal(h.writes.length, 0);
});

test('invalid cached playlists are replaced with a validated download', async () => {
    for (const cached of invalidLists) {
        const h = createPlaylist({cached});
        assert.deepEqual(await h.getPlaylist(), validList);
        assert.equal(h.requests.length, 1);
        assert.equal(h.writes.length, 1);
        assert.deepEqual(h.local.list, validList);
        assert.equal(h.local.TOTAL_PLAYED, 1234);
        await h.getPlaylist();
        assert.equal(h.requests.length, 1);
    }
});

test('invalid mirror responses are never cached and fall back to the next mirror', async () => {
    for (const invalid of invalidLists) {
        const h = createPlaylist({responses: [invalid, validList]});
        assert.deepEqual(await h.getPlaylist(), validList);
        assert.deepEqual(h.requests, [
            'https://static.kgm.pp.ua/mp3/playlist.txt',
            'https://keygenmusic.tk/mp3/kgm/playlist.txt',
        ]);
        assert.equal(h.writes.length, 1);
        assert.deepEqual(h.writes[0].list, validList);
    }
});

test('a failed refresh preserves the previously valid cache', async () => {
    const h = createPlaylist({cached: validList, responses: [[null], {length: 1}]});
    await assert.rejects(h.refresh(), /Unable to get playlist/);
    assert.equal(h.writes.length, 0);
    assert.deepEqual(await h.getPlaylist(), validList);
    assert.equal(h.requests.length, 2);
});

test('invalid cache is never returned when every mirror fails, and a later call retries', async () => {
    const h = createPlaylist({
        cached: {length: 1},
        responses: [new Error('Offline'), [null], validList],
    });
    await assert.rejects(h.getPlaylist(), /Unable to get playlist/);
    assert.equal(h.writes.length, 0);
    assert.deepEqual(await h.getPlaylist(), validList);
    assert.equal(h.requests.length, 3);
    assert.deepEqual(h.local.list, validList);
});
