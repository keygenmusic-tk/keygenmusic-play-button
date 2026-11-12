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
    #listeningStartedAt = null;
    #playedMsec = 0;
    #curMirrorIndex;
    #lastWorkingMirrorIndex;
    #mirrorAttempts = 0;
    #playbackController;
    #isBuffering = false;

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
        this.#isBuffering = false;
        this.#pauseListeningTime();
        this.#audio.pause();
        this.#notifyPlaybackState('loading');

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
            this.#startListeningTime();
            this.dispatchEvent(new CustomEvent('play', {
                detail: {
                    info: playlistElement.st,
                    mirror: this.#mirrors[this.#curMirrorIndex],
                    playedMsec: this.#takePlayedTime(),
                },
            }));
        } catch (e) {
            if (this.#playbackController !== controller) return;
            this.#tryNextMirror();
        } finally {
            clearTimeout(timeoutId);
        }
    }

    #notifyPlaybackState(state) {
        // Toolbar-only updates must not report listening intervals again.
        this.dispatchEvent(new CustomEvent('statechange', {
            detail: {state, info: this.#playlist[this.#curPlaylistPos].st},
        }));
    }

    #startListeningTime() {
        if (this.#listeningStartedAt !== null || !this.#playbackController || this.isLoading
            || this.#audio.paused || this.#audio.ended || this.#audio.readyState < 3) return;
        this.#listeningStartedAt = performance.now();
    }

    #pauseListeningTime() {
        if (this.#listeningStartedAt === null) return;
        this.#playedMsec += performance.now() - this.#listeningStartedAt;
        this.#listeningStartedAt = null;
    }

    #takePlayedTime() {
        // Report completed listening intervals once, retaining them across mirror retries.
        const playedMsec = this.#playedMsec;
        this.#playedMsec = 0;
        return playedMsec;
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
        this.#isBuffering = false;
        this.#pauseListeningTime();
        this.#audio.pause();
        this.isPlaying = false;
        this.#curMirrorIndex = this.#lastWorkingMirrorIndex;
        this.#mirrorAttempts = 0;
        this.dispatchEvent(new CustomEvent('stop', {
            detail: {
                playedMsec: this.#takePlayedTime(),
            },
        }));
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
        this.#audio.addEventListener('playing', () => {
            if (!this.#playbackController || this.isLoading || this.#audio.paused
                || this.#audio.ended || this.#audio.readyState < 3) return;
            this.#startListeningTime();
            if (this.#isBuffering) {
                this.#isBuffering = false;
                this.#notifyPlaybackState('playing');
            }
        });
        this.#audio.addEventListener('waiting', () => {
            if (!this.#playbackController || this.#audio.paused || this.#audio.ended
                || this.#audio.readyState >= 3) return;
            this.#pauseListeningTime();
            if (!this.isLoading && !this.#isBuffering) {
                this.#isBuffering = true;
                this.#notifyPlaybackState('loading');
            }
        });
        this.#audio.addEventListener('pause', () => {
            // A queued pause event may arrive after a newer playback has started.
            if (!this.#audio.paused) return;
            this.#pauseListeningTime();
            // Internal pauses during startup and track changes are not user stops.
            if (this.#playbackController && !this.isLoading && !this.#audio.ended) this.stop();
        });
        this.#audio.addEventListener('ended', () => {
            this.#pauseListeningTime();
            if (this.isPlaying) this.next();
        });
        this.#audio.addEventListener('error', () => {
            this.#pauseListeningTime();
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
