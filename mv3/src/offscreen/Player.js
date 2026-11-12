import {shuffleArray} from '../utils/utils';

const MIRROR_CHECK_TIMEOUT_MS = 3000;
const AUDIO_START_TIMEOUT_MS = 10000;

export class Player extends EventTarget {
    isPlaying = false;
    isLoading = false;
    #audio = new Audio();
    #playlist = [];
    #mirrors = [];
    #curPlaylistPos = 0;
    #startTime = 0;
    #curMirrorIndex;
    #lastWorkingMirrorIndex;
    #mirrorAttempts = 0;
    #playbackController;

    constructor(playlist, mirrors, preferredMirror) {
        super();
        this.#mirrors = mirrors;
        this.#curMirrorIndex = Math.max(0, mirrors.indexOf(preferredMirror));
        this.#lastWorkingMirrorIndex = this.#curMirrorIndex;
        this.#playlist = playlist;
        this.#initPlaylist();
        this.#listenAudioEvents();
    }

    play() {
        this.#mirrorAttempts = 0;
        return this.#play();
    }

    async #play() {
        this.#playbackController?.abort();
        const controller = new AbortController();
        this.#playbackController = controller;
        this.isLoading = true;
        this.#audio.pause();

        const playlistElement = this.#playlist[this.#curPlaylistPos];
        const trackUrl = this.#mirrors[this.#curMirrorIndex] + playlistElement.p;
        let timeoutId = setTimeout(() => controller.abort(), MIRROR_CHECK_TIMEOUT_MS);
        // Aborting fetch alone cannot cancel a pending audio.play() promise.
        const aborted = new Promise((resolve, reject) => {
            controller.signal.addEventListener('abort', () => {
                reject(new DOMException('Playback cancelled or timed out', 'AbortError'));
            }, {once: true});
        });

        try {
            const response = await Promise.race([fetch(trackUrl, {
                method: 'HEAD',
                signal: controller.signal,
            }), aborted]);
            if (!response.ok) throw new Error('Mirror request failed: ' + response.status);

            // Ignore results from playback that has been stopped or replaced.
            if (this.#playbackController !== controller) return;
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => controller.abort(), AUDIO_START_TIMEOUT_MS);

            this.#audio.src = trackUrl;
            await Promise.race([this.#audio.play(), aborted]);
            if (this.#playbackController !== controller) return;
            this.isLoading = false;
            this.isPlaying = true;
            this.#lastWorkingMirrorIndex = this.#curMirrorIndex;
            this.#mirrorAttempts = 0;
            const now = Date.now();
            this.dispatchEvent(new CustomEvent('play', {
                detail: {
                    info: playlistElement.st,
                    mirror: this.#mirrors[this.#curMirrorIndex],
                    playedMsec: this.#startTime ? now - this.#startTime : 0,
                },
            }));
            this.#startTime = now;
        } catch (e) {
            if (this.#playbackController !== controller) return;
            this.#tryNextMirror();
        } finally {
            clearTimeout(timeoutId);
        }
    }

    #tryNextMirror() {
        this.#mirrorAttempts++;
        if (this.#mirrorAttempts >= this.#mirrors.length) {
            this.stop();
        } else {
            this.#curMirrorIndex = (this.#curMirrorIndex + 1) % this.#mirrors.length;
            this.#play();
        }
    }

    stop() {
        this.#playbackController?.abort();
        this.#playbackController = null;
        this.isLoading = false;
        this.#audio.pause();
        this.isPlaying = false;
        this.#curMirrorIndex = this.#lastWorkingMirrorIndex;
        this.#mirrorAttempts = 0;
        this.dispatchEvent(new CustomEvent('stop', {
            detail: {
                playedMsec: this.#startTime ? Date.now() - this.#startTime : 0,
            },
        }));
        this.#startTime = 0;
        this.#initPlaylist();
    }

    next() {
        this.#curPlaylistPos++;
        if (this.#curPlaylistPos >= this.#playlist.length) {
            this.#curPlaylistPos = 0;
        }
        this.play();
    }

    prev() {
        this.#curPlaylistPos--;
        if (this.#curPlaylistPos < 0) {
            this.#curPlaylistPos = this.#playlist.length - 1;
        }
        this.play();
    }

    #initPlaylist() {
        this.#playlist = shuffleArray(this.#playlist);
        this.#curPlaylistPos = 0;
    }

    #listenAudioEvents() {
        this.#audio.addEventListener('ended', () => {
            if (this.isPlaying) this.next();
        });
        this.#audio.addEventListener('error', () => {
            // During startup, play() rejects on media errors. Handle that once in #play().
            if (!this.#playbackController || this.isLoading) return;
            this.#tryNextMirror();
        });
        if ('mediaSession' in navigator) {
            navigator.mediaSession.setActionHandler('nexttrack', () => this.next());
            navigator.mediaSession.setActionHandler('previoustrack', () => this.prev());
            navigator.mediaSession.setActionHandler('stop', () => this.stop());
        }
    }
}
