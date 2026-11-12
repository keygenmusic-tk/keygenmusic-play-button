import {KGM_MIRRORS} from '../consts';

const PLAYLIST_TIMEOUT_MS = 10000;

export const fetchAndUpdateList = async () => {
    let mirrorIndex = 0;
    // trying to get playlist from mirrors if some servers down
    while (mirrorIndex < KGM_MIRRORS.length) {
        try {
            const playlistUrl = KGM_MIRRORS[mirrorIndex] + 'playlist.txt';
            const resp = await fetch(playlistUrl, {
                signal: AbortSignal.timeout(PLAYLIST_TIMEOUT_MS),
            });
            if (!resp.ok) throw new Error('Playlist request failed: ' + resp.status);
            const list = await resp.json();
            if (!list?.length) throw new Error('Invalid list');
            await chrome.storage.local.set({list});
            return list;
        } catch (e) {
            mirrorIndex++;
        }
    }
    throw new Error('Unable to get playlist');
};

export const getPlaylist = async () => {
    const storage = await chrome.storage.local.get({list: null});
    if (storage?.list) return storage.list;
    return fetchAndUpdateList();
};
