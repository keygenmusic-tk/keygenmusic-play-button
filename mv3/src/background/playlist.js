import {KGM_MIRRORS} from '../consts';

const PLAYLIST_TIMEOUT_MS = 10000;

const isValidPlaylist = list => {
    if (!Array.isArray(list) || list.length === 0) return false;
    for (const track of list) {
        if (!track || typeof track !== 'object' || Array.isArray(track)
            || typeof track.p !== 'string' || !track.p.trim()
            || typeof track.st !== 'string' || !track.st.trim()) return false;
    }
    return true;
};

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
            if (!isValidPlaylist(list)) throw new Error('Invalid list');
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
    if (isValidPlaylist(storage?.list)) return storage.list;
    return fetchAndUpdateList();
};
