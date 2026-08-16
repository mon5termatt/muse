import {createHash, randomBytes} from 'node:crypto';
import {URL} from 'node:url';
import {inject, injectable} from 'inversify';
import got, {Got} from 'got';
import {TYPES} from '../types.js';
import Config from './config.js';
import {MediaSource, QueuedPlaylist, SongMetadata} from './player-types.js';

const SUBSONIC_VERSION = '1.16.1';
const CLIENT_NAME = 'muse';
const DISCORD_CHOICE_MAX_LENGTH = 100;

interface SubsonicError {
  code: number;
  message: string;
}

interface SubsonicChild {
  id: string;
  title?: string;
  album?: string;
  artist?: string;
  duration?: number;
  coverArt?: string;
  albumId?: string;
}

interface SubsonicAlbum {
  id: string;
  name?: string;
  song?: SubsonicChild[];
}

interface SubsonicPlaylist {
  id: string;
  name?: string;
  entry?: SubsonicChild[];
}

interface SubsonicEnvelope<T extends Record<string, unknown>> {
  'subsonic-response': T & {
    status: 'ok' | 'failed';
    error?: SubsonicError;
  };
}

export type NavidromeResourceType = 'song' | 'album' | 'playlist';

export interface NavidromeResource {
  type: NavidromeResourceType;
  id: string;
}

export interface NavidromeSuggestion {
  name: string;
  value: string;
}

@injectable()
export default class {
  private readonly username: string;
  private readonly password: string;
  private readonly baseUrl: string;
  private readonly got: Got;

  constructor(@inject(TYPES.Config) config: Config) {
    this.username = config.NAVIDROME_USER;
    this.password = config.NAVIDROME_PASSWORD;
    this.baseUrl = config.NAVIDROME_URL.replace(/\/+$/, '');
    this.got = got.extend({
      prefixUrl: `${this.baseUrl}/rest`,
    });
  }

  matchesUrl(url: URL): boolean {
    if (url.protocol === 'navidrome:') {
      return true;
    }

    try {
      return url.host === new URL(this.baseUrl).host;
    } catch {
      return false;
    }
  }

  parseResource(input: string | URL): NavidromeResource | null {
    let url: URL;
    try {
      url = input instanceof URL ? input : new URL(input);
    } catch {
      return null;
    }

    if (url.protocol === 'navidrome:') {
      const hostType = url.host as NavidromeResourceType;
      const id = decodeURIComponent(url.pathname.replace(/^\//, ''));
      if ((hostType === 'song' || hostType === 'album' || hostType === 'playlist') && id) {
        return {type: hostType, id};
      }

      return null;
    }

    const hash = url.hash.replace(/^#/, '');
    const hashMatch = /^\/(album|playlist|song)\/([^/?]+)/.exec(hash);
    if (hashMatch) {
      return {
        type: hashMatch[1] as NavidromeResourceType,
        id: decodeURIComponent(hashMatch[2]),
      };
    }

    const pathMatch = /\/(album|playlist|song)\/([^/]+)/.exec(url.pathname);
    if (pathMatch) {
      return {
        type: pathMatch[1] as NavidromeResourceType,
        id: decodeURIComponent(pathMatch[2]),
      };
    }

    const queryId = url.searchParams.get('id');
    if (queryId && /getSong/i.test(url.pathname)) {
      return {type: 'song', id: queryId};
    }

    if (queryId && /getAlbum/i.test(url.pathname)) {
      return {type: 'album', id: queryId};
    }

    if (queryId && /getPlaylist/i.test(url.pathname)) {
      return {type: 'playlist', id: queryId};
    }

    return null;
  }

  async search(query: string): Promise<SongMetadata[]> {
    const songs = await this.searchSongs(query, 1);
    const first = songs.at(0);
    return first ? [this.toSongMetadata(first)] : [];
  }

  async suggest(query: string, limit = 10): Promise<NavidromeSuggestion[]> {
    const songs = await this.searchSongs(query, limit);
    return songs.map(song => {
      const artist = this.displayText(song.artist, 'Unknown artist');
      const title = this.displayText(song.title, song.id);
      const name = this.truncateChoice(`Library: ${artist} - ${title}`);
      return {
        name,
        value: this.getResourceUri('song', song.id),
      };
    });
  }

  async resolveUrl(input: string | URL, playlistLimit: number): Promise<SongMetadata[]> {
    const resource = this.parseResource(input);
    if (!resource) {
      throw new Error('that doesn\'t exist');
    }

    switch (resource.type) {
      case 'song': {
        const song = await this.getSong(resource.id);
        return song ? [song] : [];
      }

      case 'album':
        return this.getAlbum(resource.id, playlistLimit);
      case 'playlist':
        return this.getPlaylist(resource.id, playlistLimit);
      default:
        return [];
    }
  }

  async getSong(id: string): Promise<SongMetadata | null> {
    const response = await this.request<{song?: SubsonicChild}>('getSong.view', {id});
    return response.song ? this.toSongMetadata(response.song) : null;
  }

  async getAlbum(id: string, playlistLimit: number): Promise<SongMetadata[]> {
    const response = await this.request<{album?: SubsonicAlbum}>('getAlbum.view', {id});
    const {album} = response;
    if (!album) {
      return [];
    }

    const playlist: QueuedPlaylist = {
      title: album.name ?? 'Album',
      source: this.getResourceUri('album', album.id),
    };

    return (album.song ?? [])
      .slice(0, playlistLimit)
      .map(song => this.toSongMetadata(song, playlist));
  }

  async getPlaylist(id: string, playlistLimit: number): Promise<SongMetadata[]> {
    const response = await this.request<{playlist?: SubsonicPlaylist}>('getPlaylist.view', {id});
    const playlistResponse = response.playlist;
    if (!playlistResponse) {
      return [];
    }

    const playlist: QueuedPlaylist = {
      title: playlistResponse.name ?? 'Playlist',
      source: this.getResourceUri('playlist', playlistResponse.id),
    };

    return (playlistResponse.entry ?? [])
      .slice(0, playlistLimit)
      .map(song => this.toSongMetadata(song, playlist));
  }

  getStreamUrl(songId: string): string {
    return this.buildRestUrl('stream.view', {id: songId});
  }

  getSongPageUrl(songId: string): string {
    return `${this.baseUrl}/app/#/song/${encodeURIComponent(songId)}`;
  }

  getResourceUri(type: NavidromeResourceType, id: string): string {
    return `navidrome://${type}/${encodeURIComponent(id)}`;
  }

  private async searchSongs(query: string, songCount: number): Promise<SubsonicChild[]> {
    const response = await this.request<{searchResult3?: {song?: SubsonicChild[]}}>('search3.view', {
      query,
      songCount: String(songCount),
      artistCount: '0',
      albumCount: '0',
    });

    return response.searchResult3?.song ?? [];
  }

  private toSongMetadata(song: SubsonicChild, playlist: QueuedPlaylist | null = null): SongMetadata {
    const coverArtId = song.coverArt ?? song.id;
    return {
      title: this.displayText(song.title, 'Unknown title'),
      artist: this.displayText(song.artist, 'Unknown artist'),
      url: song.id,
      length: Math.max(0, Math.floor(song.duration ?? 0)),
      offset: 0,
      playlist,
      isLive: false,
      thumbnailUrl: this.buildRestUrl('getCoverArt.view', {id: coverArtId, size: '300'}),
      pageUrl: this.getSongPageUrl(song.id),
      source: MediaSource.Navidrome,
    };
  }

  private async request<T extends Record<string, unknown>>(
    endpoint: string,
    searchParams: Record<string, string>,
  ): Promise<T> {
    const body = await this.got(endpoint, {
      searchParams: {
        ...this.authParams(),
        ...searchParams,
      },
    }).json<SubsonicEnvelope<T>>();

    const payload = body['subsonic-response'];
    if (!payload || payload.status === 'failed') {
      throw new Error(payload?.error?.message ?? 'Navidrome request failed');
    }

    return payload;
  }

  private buildRestUrl(endpoint: string, searchParams: Record<string, string>): string {
    const url = new URL(`${this.baseUrl}/rest/${endpoint}`);
    for (const [key, value] of Object.entries({...this.authParams(), ...searchParams})) {
      url.searchParams.set(key, value);
    }

    return url.toString();
  }

  private authParams() {
    const salt = randomBytes(12).toString('hex');
    const token = createHash('md5').update(`${this.password}${salt}`).digest('hex');
    return {
      u: this.username,
      t: token,
      s: salt,
      v: SUBSONIC_VERSION,
      c: CLIENT_NAME,
      f: 'json',
    };
  }

  private displayText(value: string | undefined, fallback: string): string {
    const trimmed = value?.trim();
    if (trimmed === undefined || trimmed === '') {
      return fallback;
    }

    return trimmed;
  }

  private truncateChoice(value: string): string {
    if (value.length <= DISCORD_CHOICE_MAX_LENGTH) {
      return value;
    }

    return `${value.slice(0, DISCORD_CHOICE_MAX_LENGTH - 3)}...`;
  }
}
