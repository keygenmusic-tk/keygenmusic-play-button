import {shuffleArray} from '../utils/utils';


export class Player extends EventTarget {
    isPlaying = false;
    isLoading = false;
    #audio = new Audio();
    #playlist = [];
    #mirrors = [];
    #curPlaylistPos = 0;
    #startTime = 0;
    #curMirrorIndex = 0;
    #playbackController;

    constructor(playlist, mirrors) {
        super();
        this.#mirrors = mirrors;
        this.#playlist = playlist;
        this.#initPlaylist();
        this.#listenAudioEvents();
    }

    async play() {
        this.#playbackController?.abort();
        const controller = new AbortController();
        this.#playbackController = controller;
        this.isLoading = true;
        this.#audio.pause();

        const playlistElement = this.#playlist[this.#curPlaylistPos];
        const trackUrl = this.#mirrors[this.#curMirrorIndex] + playlistElement.p;
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        try {
            // check if mirror response. if no, dispatch an error event to try next mirror
            // without this will have to wait until timeout error will be fired by play function. it could take too long
            await fetch(trackUrl, {
                method: 'HEAD',
                signal: controller.signal,
            });
        } catch (e) {
            if (this.#playbackController !== controller) return;
            this.#audio.dispatchEvent(new Event('error'));
            return;
        } finally {
            clearTimeout(timeoutId);
        }

        // Ignore results from playback that has been stopped or replaced.
        if (this.#playbackController !== controller) return;
        this.#audio.src = trackUrl;
        try {
            await this.#audio.play();
            if (this.#playbackController !== controller) return;
            this.isLoading = false;
            this.isPlaying = true;
            const now = Date.now();
            this.dispatchEvent(new CustomEvent('play', {
                detail: {
                    info: playlistElement.st,
                    playedMsec: this.#startTime ? now - this.#startTime : 0,
                },
            }));
            this.#startTime = now;
        } catch (e) {
            if (this.#playbackController !== controller) return;
            this.isLoading = false;
            console.log('Error playing', e);
        }
    }

    stop() {
        this.#playbackController?.abort();
        this.#playbackController = null;
        this.isLoading = false;
        this.#audio.pause();
        this.isPlaying = false;
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
            if (!this.#playbackController) return;
            // try to play from another mirror
            if (this.#curMirrorIndex >= this.#mirrors.length - 1) {
                this.#startTime = 0;
                this.stop();
            } else {
                this.#curMirrorIndex++;
                this.play();
            }
        });
        if ('mediaSession' in navigator) {
            navigator.mediaSession.setActionHandler('nexttrack', () => this.next());
            navigator.mediaSession.setActionHandler('previoustrack', () => this.prev());
            navigator.mediaSession.setActionHandler('stop', () => this.stop());
        }
    }
}
