import {inject, injectable, optional} from 'inversify';
import * as spotifyURI from 'spotify-uri';
import {SongMetadata, QueuedPlaylist, MediaSource} from './player.js';
import {TYPES} from '../types.js';
import ffmpeg from 'fluent-ffmpeg';
import YoutubeAPI from './youtube-api.js';
import SpotifyAPI, {SpotifyTrack} from './spotify-api.js';
import NavidromeAPI from './navidrome-api.js';
import {URL} from 'node:url';

export type PlaySource = 'auto' | 'youtube' | 'library';

@injectable()
export default class {
  private readonly youtubeAPI: YoutubeAPI;
  private readonly spotifyAPI?: SpotifyAPI;
  private readonly navidromeAPI?: NavidromeAPI;

  constructor(
    @inject(TYPES.Services.YoutubeAPI) youtubeAPI: YoutubeAPI,
    @inject(TYPES.Services.SpotifyAPI) @optional() spotifyAPI?: SpotifyAPI,
    @inject(TYPES.Services.NavidromeAPI) @optional() navidromeAPI?: NavidromeAPI,
  ) {
    this.youtubeAPI = youtubeAPI;
    this.spotifyAPI = spotifyAPI;
    this.navidromeAPI = navidromeAPI;
  }

  async getSongs(
    query: string,
    playlistLimit: number,
    shouldSplitChapters: boolean,
    source: PlaySource = 'auto',
  ): Promise<[SongMetadata[], string]> {
    const newSongs: SongMetadata[] = [];
    let extraMsg = '';
    let url: URL | undefined;

    // Test if it's a complete URL
    try {
      url = new URL(query);
    } catch (_: unknown) {
      url = undefined;
    }

    const supportedProtocols = ['http:', 'https:', 'spotify:', 'navidrome:'];

    if (!url || !supportedProtocols.includes(url.protocol)) {
      return this.fromFreeText(query, playlistLimit, shouldSplitChapters, source);
    }

    const YOUTUBE_HOSTS = [
      'www.youtube.com',
      'youtu.be',
      'youtube.com',
      'music.youtube.com',
      'www.music.youtube.com',
    ];

    if (YOUTUBE_HOSTS.includes(url.host)) {
      // YouTube source
      if (url.searchParams.get('list')) {
        // YouTube playlist
        const songs = await this.youtubePlaylist(url.searchParams.get('list')!, shouldSplitChapters);
        newSongs.push(...songs.slice(0, playlistLimit));
      } else {
        const songs = await this.youtubeVideo(url.href, shouldSplitChapters);

        if (songs) {
          newSongs.push(...songs);
        } else {
          throw new Error('that doesn\'t exist');
        }
      }
    } else if (url.protocol === 'spotify:' || url.host === 'open.spotify.com') {
      if (this.spotifyAPI === undefined) {
        throw new Error('Spotify is not enabled!');
      }

      const [convertedSongs, nSongsNotFound, totalSongs] = await this.spotifySource(query, playlistLimit, shouldSplitChapters);

      if (totalSongs > playlistLimit) {
        extraMsg = `a random sample of ${playlistLimit} songs was taken`;
      }

      if (totalSongs > playlistLimit && nSongsNotFound !== 0) {
        extraMsg += ' and ';
      }

      if (nSongsNotFound !== 0) {
        if (nSongsNotFound === 1) {
          extraMsg += '1 song was not found';
        } else {
          extraMsg += `${nSongsNotFound.toString()} songs were not found`;
        }
      }

      newSongs.push(...convertedSongs);
    } else if (url.protocol === 'navidrome:' || this.navidromeAPI?.matchesUrl(url)) {
      newSongs.push(...await this.fromNavidromeUrl(url, playlistLimit));
    } else {
      const song = await this.httpLiveStream(query);

      if (song) {
        newSongs.push(song);
      } else {
        throw new Error('that doesn\'t exist');
      }
    }

    return [newSongs, extraMsg];
  }

  private async fromFreeText(query: string, playlistLimit: number, shouldSplitChapters: boolean, source: PlaySource): Promise<[SongMetadata[], string]> {
    if (source !== 'youtube' && this.navidromeAPI) {
      const songs = await this.navidromeAPI.search(query, playlistLimit, {
        allowSongFallback: source === 'library',
      });

      if (songs.length > 0) {
        return [songs, ''];
      }

      if (source === 'library') {
        throw new Error('that doesn\'t exist');
      }
    }

    if (source === 'library') {
      throw new Error('Navidrome is not enabled!');
    }

    const songs = await this.youtubeVideoSearch(query, shouldSplitChapters);

    if (songs) {
      return [songs, ''];
    }

    throw new Error('that doesn\'t exist');
  }

  private async fromNavidromeUrl(url: URL, playlistLimit: number): Promise<SongMetadata[]> {
    if (this.navidromeAPI === undefined) {
      throw new Error('Navidrome is not enabled!');
    }

    const songs = await this.navidromeAPI.resolveUrl(url, playlistLimit);

    if (songs.length === 0) {
      throw new Error('that doesn\'t exist');
    }

    return songs;
  }

  private async youtubeVideoSearch(query: string, shouldSplitChapters: boolean): Promise<SongMetadata[]> {
    return this.youtubeAPI.search(query, shouldSplitChapters);
  }

  private async youtubeVideo(url: string, shouldSplitChapters: boolean): Promise<SongMetadata[]> {
    return this.youtubeAPI.getVideo(url, shouldSplitChapters);
  }

  private async youtubePlaylist(listId: string, shouldSplitChapters: boolean): Promise<SongMetadata[]> {
    return this.youtubeAPI.getPlaylist(listId, shouldSplitChapters);
  }

  private async spotifySource(url: string, playlistLimit: number, shouldSplitChapters: boolean): Promise<[SongMetadata[], number, number]> {
    if (this.spotifyAPI === undefined) {
      return [[], 0, 0];
    }

    const parsed = spotifyURI.parse(url);

    switch (parsed.type) {
      case 'album': {
        const [tracks, playlist] = await this.spotifyAPI.getAlbum(url, playlistLimit);
        return this.spotifyToYouTube(tracks, shouldSplitChapters, playlist);
      }

      case 'playlist': {
        const [tracks, playlist] = await this.spotifyAPI.getPlaylist(url, playlistLimit);
        return this.spotifyToYouTube(tracks, shouldSplitChapters, playlist);
      }

      case 'track': {
        const tracks = [await this.spotifyAPI.getTrack(url)];
        return this.spotifyToYouTube(tracks, shouldSplitChapters);
      }

      case 'artist': {
        const tracks = await this.spotifyAPI.getArtist(url, playlistLimit);
        return this.spotifyToYouTube(tracks, shouldSplitChapters);
      }

      default: {
        return [[], 0, 0];
      }
    }
  }

  private async httpLiveStream(url: string): Promise<SongMetadata> {
    return new Promise((resolve, reject) => {
      ffmpeg(url).ffprobe((err, _) => {
        if (err) {
          reject(err);
          return;
        }

        resolve({
          url,
          source: MediaSource.HLS,
          isLive: true,
          title: url,
          artist: url,
          length: 0,
          offset: 0,
          playlist: null,
          thumbnailUrl: null,
        });
      });
    });
  }

  private async spotifyToYouTube(tracks: SpotifyTrack[], shouldSplitChapters: boolean, playlist?: QueuedPlaylist | undefined): Promise<[SongMetadata[], number, number]> {
    const promisedResults = tracks.map(async track => this.youtubeAPI.search(`"${track.name}" "${track.artist}"`, shouldSplitChapters));
    const searchResults = await Promise.allSettled(promisedResults);

    let nSongsNotFound = 0;

    // Count songs that couldn't be found
    const songs: SongMetadata[] = searchResults.reduce((accum: SongMetadata[], result) => {
      if (result.status === 'fulfilled') {
        if (result.value.length === 0) {
          nSongsNotFound++;
        }

        for (const v of result.value) {
          accum.push({
            ...v,
            ...(playlist ? {playlist} : {}),
          });
        }
      } else {
        nSongsNotFound++;
      }

      return accum;
    }, []);

    return [songs, nSongsNotFound, tracks.length];
  }
}
