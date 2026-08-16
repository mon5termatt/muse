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
  artistId?: string;
  duration?: number;
  coverArt?: string;
  albumId?: string;
}

interface SubsonicAlbum {
  id: string;
  name?: string;
  artist?: string;
  coverArt?: string;
  song?: SubsonicChild[];
}

interface SubsonicArtist {
  id: string;
  name?: string;
  coverArt?: string;
  album?: SubsonicAlbum[];
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

export type NavidromeResourceType = 'song' | 'album' | 'playlist' | 'artist';

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
      if ((hostType === 'song' || hostType === 'album' || hostType === 'playlist' || hostType === 'artist') && id) {
        return {type: hostType, id};
      }

      return null;
    }

    const hash = url.hash.replace(/^#/, '');
    const hashMatch = /^\/(album|playlist|song|artist)\/([^/?]+)/.exec(hash);
    if (hashMatch) {
      return {
        type: hashMatch[1] as NavidromeResourceType,
        id: decodeURIComponent(hashMatch[2]),
      };
    }

    const pathMatch = /\/(album|playlist|song|artist)\/([^/]+)/.exec(url.pathname);
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

    if (queryId && /getArtist/i.test(url.pathname)) {
      return {type: 'artist', id: queryId};
    }

    return null;
  }

  async search(query: string, playlistLimit: number, options: {allowSongFallback?: boolean} = {}): Promise<SongMetadata[]> {
    const allowSongFallback = options.allowSongFallback ?? true;
    const {artists, albums, songs} = await this.searchLibrary(query, {
      artistCount: 10,
      albumCount: 10,
      songCount: 10,
    });

    const artist = this.pickArtistMatch(query, artists, songs);
    if (artist) {
      return this.getArtistDiscography(artist.id, playlistLimit);
    }

    const album = this.pickAlbumMatch(query, albums, songs);
    if (album) {
      return this.getAlbum(album.id, playlistLimit);
    }

    const exactSong = songs.find(song => this.namesMatch(song.title, query));
    if (exactSong) {
      return [this.toSongMetadata(exactSong)];
    }

    const partialArtist = this.pickPartialArtistMatch(query, artists, songs);
    if (partialArtist) {
      return this.getArtistDiscography(partialArtist.id, playlistLimit);
    }

    if (!allowSongFallback) {
      return [];
    }

    const first = songs.at(0);
    return first ? [this.toSongMetadata(first)] : [];
  }

  async suggest(query: string, limit = 10): Promise<NavidromeSuggestion[]> {
    const artistSlots = Math.min(3, Math.ceil(limit / 3));
    const albumSlots = Math.min(3, Math.ceil(limit / 3));
    const {artists, albums, songs} = await this.searchLibrary(query, {
      artistCount: artistSlots,
      albumCount: albumSlots,
      songCount: limit,
    });

    const artistSuggestions = artists.slice(0, artistSlots).map(artist => ({
      name: this.truncateChoice(`Library: 🎤 ${this.displayText(artist.name, artist.id)}`),
      value: this.getResourceUri('artist', artist.id),
    }));

    const remainingAfterArtists = Math.max(0, limit - artistSuggestions.length);
    const albumSuggestions = albums.slice(0, Math.min(albumSlots, remainingAfterArtists)).map(album => {
      const albumName = this.displayText(album.name, album.id);
      const artist = this.displayText(album.artist, '');
      const label = artist === '' ? albumName : `${albumName} - ${artist}`;
      return {
        name: this.truncateChoice(`Library: 💿 ${label}`),
        value: this.getResourceUri('album', album.id),
      };
    });

    const remaining = Math.max(0, limit - artistSuggestions.length - albumSuggestions.length);
    const songSuggestions = songs.slice(0, remaining).map(song => {
      const artist = this.displayText(song.artist, 'Unknown artist');
      const title = this.displayText(song.title, song.id);
      return {
        name: this.truncateChoice(`Library: 🎵 ${artist} - ${title}`),
        value: this.getResourceUri('song', song.id),
      };
    });

    return [...artistSuggestions, ...albumSuggestions, ...songSuggestions];
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
      case 'artist':
        return this.getArtistDiscography(resource.id, playlistLimit);
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

  async getArtistDiscography(id: string, playlistLimit: number): Promise<SongMetadata[]> {
    const response = await this.request<{artist?: SubsonicArtist}>('getArtist.view', {id});
    const {artist} = response;
    if (!artist) {
      return [];
    }

    const playlist: QueuedPlaylist = {
      title: artist.name ?? 'Artist',
      source: this.getResourceUri('artist', artist.id),
    };

    const songs: SongMetadata[] = [];
    for (const album of artist.album ?? []) {
      if (songs.length >= playlistLimit) {
        break;
      }

      // eslint-disable-next-line no-await-in-loop
      const albumSongs = await this.getAlbum(album.id, playlistLimit - songs.length);
      songs.push(...albumSongs.map(song => ({...song, playlist})));
    }

    return songs;
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

  private async searchLibrary(query: string, counts: {albumCount: number; artistCount: number; songCount: number}): Promise<{
    albums: SubsonicAlbum[];
    artists: SubsonicArtist[];
    songs: SubsonicChild[];
  }> {
    const response = await this.request<{searchResult3?: {
      album?: SubsonicAlbum[];
      artist?: SubsonicArtist[];
      song?: SubsonicChild[];
    };}>('search3.view', {
      query,
      albumCount: String(counts.albumCount),
      artistCount: String(counts.artistCount),
      songCount: String(counts.songCount),
    });

    return {
      albums: response.searchResult3?.album ?? [],
      artists: response.searchResult3?.artist ?? [],
      songs: response.searchResult3?.song ?? [],
    };
  }

  private pickArtistMatch(query: string, artists: SubsonicArtist[], songs: SubsonicChild[]): SubsonicArtist | undefined {
    const exactArtist = artists.find(artist => this.namesMatch(artist.name, query));
    if (exactArtist) {
      return exactArtist;
    }

    const songFromNamedArtist = songs.find(song => this.namesMatch(song.artist, query) && Boolean(song.artistId));
    if (songFromNamedArtist?.artistId) {
      return artists.find(artist => artist.id === songFromNamedArtist.artistId) ?? {
        id: songFromNamedArtist.artistId,
        name: songFromNamedArtist.artist,
      };
    }

    return undefined;
  }

  private pickPartialArtistMatch(query: string, artists: SubsonicArtist[], songs: SubsonicChild[]): SubsonicArtist | undefined {
    if (songs.some(song => this.namesMatch(song.title, query))) {
      return undefined;
    }

    return artists.find(artist => this.nameContains(artist.name, query));
  }

  private pickAlbumMatch(query: string, albums: SubsonicAlbum[], songs: SubsonicChild[]): SubsonicAlbum | undefined {
    const exactAlbum = albums.find(album => this.namesMatch(album.name, query));
    if (exactAlbum) {
      return exactAlbum;
    }

    const songFromNamedAlbum = songs.find(song => this.namesMatch(song.album, query) && Boolean(song.albumId));
    if (songFromNamedAlbum?.albumId) {
      return albums.find(album => album.id === songFromNamedAlbum.albumId) ?? {
        id: songFromNamedAlbum.albumId,
        name: songFromNamedAlbum.album,
        artist: songFromNamedAlbum.artist,
      };
    }

    if (songs.some(song => this.namesMatch(song.title, query))) {
      return undefined;
    }

    return albums.find(album => this.nameContains(album.name, query));
  }

  private namesMatch(left: string | undefined, right: string | undefined): boolean {
    const a = this.normalizeName(left);
    const b = this.normalizeName(right);
    return a !== '' && a === b;
  }

  private nameContains(haystack: string | undefined, needle: string | undefined): boolean {
    const h = this.normalizeName(haystack);
    const n = this.normalizeName(needle);
    return h !== '' && n !== '' && (h.includes(n) || n.includes(h));
  }

  private normalizeName(value: string | undefined): string {
    return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
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
