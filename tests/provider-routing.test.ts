import 'reflect-metadata';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const dependencyMocks = vi.hoisted(() => ({
  ffprobe: vi.fn(),
  shuffle: vi.fn((tracks: unknown[]) => tracks),
}));

vi.mock('fluent-ffmpeg', () => ({
  default: vi.fn((url: string) => ({
    ffprobe: (callback: (error: Error | null, data?: unknown) => void) => dependencyMocks.ffprobe(url, callback),
  })),
}));

vi.mock('array-shuffle', () => ({
  default: dependencyMocks.shuffle,
}));

vi.mock('../src/services/player.js', () => ({
  MediaSource: {Youtube: 0, HLS: 1, Navidrome: 2},
}));

import GetSongs from '../src/services/get-songs.js';
import SpotifyAPI from '../src/services/spotify-api.js';
import NavidromeAPI from '../src/services/navidrome-api.js';

const makeSong = (title: string, url = title.toLowerCase().replaceAll(' ', '-')) => ({
  title,
  artist: 'Artist',
  url,
  length: 180,
  offset: 0,
  playlist: null,
  isLive: false,
  thumbnailUrl: null,
  source: 0,
});

const makeNavidromeAPI = () => ({
  matchesUrl: vi.fn().mockReturnValue(false),
  search: vi.fn().mockResolvedValue([]),
  resolveUrl: vi.fn().mockResolvedValue([]),
});

const makeGetSongsHarness = (navidromeAPI?: ReturnType<typeof makeNavidromeAPI>) => {
  const youtubeAPI = {
    search: vi.fn().mockResolvedValue([]),
    getVideo: vi.fn().mockResolvedValue([]),
    getPlaylist: vi.fn().mockResolvedValue([]),
  };
  const spotifyAPI = {
    getAlbum: vi.fn(),
    getPlaylist: vi.fn(),
    getTrack: vi.fn(),
    getArtist: vi.fn(),
  };

  return {
    getSongs: new GetSongs(youtubeAPI as never, spotifyAPI as never, navidromeAPI as never),
    navidromeAPI,
    spotifyAPI,
    youtubeAPI,
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  dependencyMocks.ffprobe.mockImplementation((_url, callback) => callback(null, {}));
  dependencyMocks.shuffle.mockImplementation((tracks: unknown[]) => tracks);
});

describe('GetSongs provider routing', () => {
  it('uses YouTube search for a free-text query', async () => {
    const {getSongs, youtubeAPI} = makeGetSongsHarness();
    const result = [makeSong('Search result')];
    youtubeAPI.search.mockResolvedValue(result);

    await expect(getSongs.getSongs('lofi beats', 20, true)).resolves.toEqual([result, '']);
    expect(youtubeAPI.search).toHaveBeenCalledWith('lofi beats', true);
    expect(youtubeAPI.getVideo).not.toHaveBeenCalled();
    expect(youtubeAPI.getPlaylist).not.toHaveBeenCalled();
  });

  it.each([
    'Queen:Bohemian Rhapsody',
    'C418: Sweden',
  ])('uses YouTube search for colon-bearing free text %s', async query => {
    const {getSongs, spotifyAPI, youtubeAPI} = makeGetSongsHarness();
    const result = [makeSong('Search result')];
    youtubeAPI.search.mockResolvedValue(result);

    await expect(getSongs.getSongs(query, 20, true)).resolves.toEqual([result, '']);
    expect(youtubeAPI.search).toHaveBeenCalledWith(query, true);
    expect(youtubeAPI.getVideo).not.toHaveBeenCalled();
    expect(youtubeAPI.getPlaylist).not.toHaveBeenCalled();
    expect(spotifyAPI.getTrack).not.toHaveBeenCalled();
    expect(dependencyMocks.ffprobe).not.toHaveBeenCalled();
  });

  it('routes a YouTube URL directly to the video provider', async () => {
    const {getSongs, youtubeAPI} = makeGetSongsHarness();
    const result = [makeSong('YouTube result', 'abcdefghijk')];
    const url = 'https://www.youtube.com/watch?v=abcdefghijk';
    youtubeAPI.getVideo.mockResolvedValue(result);

    await expect(getSongs.getSongs(url, 20, false)).resolves.toEqual([result, '']);
    expect(youtubeAPI.getVideo).toHaveBeenCalledWith(url, false);
    expect(youtubeAPI.search).not.toHaveBeenCalled();
  });

  it('routes a Spotify URL through Spotify metadata and YouTube conversion', async () => {
    const {getSongs, spotifyAPI, youtubeAPI} = makeGetSongsHarness();
    const result = [makeSong('Spotify result', 'spotify-result')];
    const url = 'spotify:track:track-id';
    spotifyAPI.getTrack.mockResolvedValue({name: 'Spotify song', artist: 'Spotify artist'});
    youtubeAPI.search.mockResolvedValue(result);

    await expect(getSongs.getSongs(url, 20, false)).resolves.toEqual([result, '']);
    expect(spotifyAPI.getTrack).toHaveBeenCalledWith(url);
    expect(youtubeAPI.search).toHaveBeenCalledWith('"Spotify song" "Spotify artist"', false);
    expect(youtubeAPI.search).not.toHaveBeenCalledWith(url, false);
  });

  it('routes a direct-stream URL through ffprobe', async () => {
    const {getSongs, youtubeAPI} = makeGetSongsHarness();
    const url = 'https://radio.example/live.m3u8';

    const [songs, extraMessage] = await getSongs.getSongs(url, 20, false);

    expect(songs).toEqual([expect.objectContaining({
      url,
      title: url,
      artist: url,
      isLive: true,
    })]);
    expect(extraMessage).toBe('');
    expect(dependencyMocks.ffprobe).toHaveBeenCalledWith(url, expect.any(Function));
    expect(youtubeAPI.search).not.toHaveBeenCalled();
  });

  it('propagates a YouTube provider rejection without searching the literal URL', async () => {
    const {getSongs, youtubeAPI} = makeGetSongsHarness();
    const error = new Error('YouTube provider failed');
    const url = 'https://www.youtube.com/watch?v=abcdefghijk';
    youtubeAPI.getVideo.mockRejectedValue(error);
    youtubeAPI.search.mockResolvedValue([makeSong('Wrong fallback')]);

    await expect(getSongs.getSongs(url, 20, false)).rejects.toBe(error);
    expect(youtubeAPI.search).not.toHaveBeenCalled();
  });

  it('propagates a Spotify provider rejection without searching the literal URL', async () => {
    const {getSongs, spotifyAPI, youtubeAPI} = makeGetSongsHarness();
    const error = new Error('Spotify provider failed');
    const url = 'spotify:track:track-id';
    spotifyAPI.getTrack.mockRejectedValue(error);
    youtubeAPI.search.mockResolvedValue([makeSong('Wrong fallback')]);

    await expect(getSongs.getSongs(url, 20, false)).rejects.toBe(error);
    expect(youtubeAPI.search).not.toHaveBeenCalled();
  });

  it.each([
    'http://radio.example/live.m3u8',
    'https://radio.example/live.m3u8',
  ])('propagates an ffprobe rejection for %s without searching the literal URL', async url => {
    const {getSongs, youtubeAPI} = makeGetSongsHarness();
    const error = new Error('ffprobe failed');
    dependencyMocks.ffprobe.mockImplementation((_url, callback) => callback(error));
    youtubeAPI.search.mockResolvedValue([makeSong('Wrong fallback')]);

    await expect(getSongs.getSongs(url, 20, false)).rejects.toBe(error);
    expect(youtubeAPI.search).not.toHaveBeenCalled();
  });
});

describe('GetSongs collection limits and conversion accounting', () => {
  it('caps a YouTube playlist in source order', async () => {
    const {getSongs, youtubeAPI} = makeGetSongsHarness();
    const playlist = [makeSong('First'), makeSong('Second'), makeSong('Third')];
    youtubeAPI.getPlaylist.mockResolvedValue(playlist);

    await expect(getSongs.getSongs('https://www.youtube.com/playlist?list=PL123', 2, false))
      .resolves.toEqual([[playlist[0], playlist[1]], '']);
    expect(youtubeAPI.getPlaylist).toHaveBeenCalledWith('PL123', false);
  });

  it('counts a fulfilled empty Spotify conversion as one song not found', async () => {
    const {getSongs, spotifyAPI, youtubeAPI} = makeGetSongsHarness();
    spotifyAPI.getTrack.mockResolvedValue({name: 'Missing song', artist: 'Missing artist'});
    youtubeAPI.search.mockResolvedValue([]);

    await expect(getSongs.getSongs('spotify:track:missing-id', 20, false))
      .resolves.toEqual([[], '1 song was not found']);
  });
});

describe('GetSongs Navidrome library routing', () => {
  it('keeps YouTube as the default free-text search when Navidrome is enabled', async () => {
    const navidromeAPI = makeNavidromeAPI();
    const {getSongs, youtubeAPI} = makeGetSongsHarness(navidromeAPI);
    const result = [makeSong('Search result')];
    youtubeAPI.search.mockResolvedValue(result);

    await expect(getSongs.getSongs('lofi beats', 20, true)).resolves.toEqual([result, '']);
    expect(youtubeAPI.search).toHaveBeenCalledWith('lofi beats', true);
    expect(navidromeAPI.search).not.toHaveBeenCalled();
  });

  it('uses Navidrome search for free text when source is library', async () => {
    const navidromeAPI = makeNavidromeAPI();
    const result = [makeSong('Library result', 'song-id')];
    navidromeAPI.search.mockResolvedValue(result);
    const {getSongs, youtubeAPI} = makeGetSongsHarness(navidromeAPI);

    await expect(getSongs.getSongs('neon lights', 20, true, 'library')).resolves.toEqual([result, '']);
    expect(navidromeAPI.search).toHaveBeenCalledWith('neon lights');
    expect(youtubeAPI.search).not.toHaveBeenCalled();
    expect(dependencyMocks.ffprobe).not.toHaveBeenCalled();
  });

  it('throws when source is library but Navidrome is not enabled', async () => {
    const {getSongs, youtubeAPI} = makeGetSongsHarness();

    await expect(getSongs.getSongs('neon lights', 20, false, 'library'))
      .rejects.toThrow('Navidrome is not enabled!');
    expect(youtubeAPI.search).not.toHaveBeenCalled();
  });

  it('throws when a library search returns no songs', async () => {
    const navidromeAPI = makeNavidromeAPI();
    navidromeAPI.search.mockResolvedValue([]);
    const {getSongs} = makeGetSongsHarness(navidromeAPI);

    await expect(getSongs.getSongs('missing track', 20, false, 'library'))
      .rejects.toThrow('that doesn\'t exist');
  });

  it('routes a navidrome:// URL to Navidrome even without source:library', async () => {
    const navidromeAPI = makeNavidromeAPI();
    const result = [makeSong('Library song', 'song-id')];
    navidromeAPI.resolveUrl.mockResolvedValue(result);
    const {getSongs, youtubeAPI} = makeGetSongsHarness(navidromeAPI);
    const url = 'navidrome://song/song-id';

    await expect(getSongs.getSongs(url, 20, false)).resolves.toEqual([result, '']);
    expect(navidromeAPI.resolveUrl).toHaveBeenCalledWith(expect.any(URL), 20);
    expect(youtubeAPI.search).not.toHaveBeenCalled();
    expect(dependencyMocks.ffprobe).not.toHaveBeenCalled();
  });

  it('routes a configured Navidrome host URL instead of HLS', async () => {
    const navidromeAPI = makeNavidromeAPI();
    navidromeAPI.matchesUrl.mockImplementation((url: URL) => url.host === 'music.example:4533');
    const result = [makeSong('Album track', 'song-id')];
    navidromeAPI.resolveUrl.mockResolvedValue(result);
    const {getSongs, youtubeAPI} = makeGetSongsHarness(navidromeAPI);
    const url = 'https://music.example:4533/app/#/album/album-id';

    await expect(getSongs.getSongs(url, 20, false)).resolves.toEqual([result, '']);
    expect(navidromeAPI.matchesUrl).toHaveBeenCalled();
    expect(navidromeAPI.resolveUrl).toHaveBeenCalledWith(expect.any(URL), 20);
    expect(youtubeAPI.search).not.toHaveBeenCalled();
    expect(dependencyMocks.ffprobe).not.toHaveBeenCalled();
  });

  it('still uses ffprobe for non-Navidrome HTTP URLs when Navidrome is enabled', async () => {
    const navidromeAPI = makeNavidromeAPI();
    const {getSongs} = makeGetSongsHarness(navidromeAPI);
    const url = 'https://radio.example/live.m3u8';

    const [songs] = await getSongs.getSongs(url, 20, false);

    expect(songs).toEqual([expect.objectContaining({url, isLive: true})]);
    expect(navidromeAPI.resolveUrl).not.toHaveBeenCalled();
    expect(dependencyMocks.ffprobe).toHaveBeenCalledWith(url, expect.any(Function));
  });

  it('throws when a navidrome:// URL is used but Navidrome is not enabled', async () => {
    const {getSongs, youtubeAPI} = makeGetSongsHarness();

    await expect(getSongs.getSongs('navidrome://song/song-id', 20, false))
      .rejects.toThrow('Navidrome is not enabled!');
    expect(youtubeAPI.search).not.toHaveBeenCalled();
    expect(dependencyMocks.ffprobe).not.toHaveBeenCalled();
  });
});

describe('NavidromeAPI URL helpers', () => {
  const api = new NavidromeAPI({
    NAVIDROME_URL: 'https://music.example:4533/',
    NAVIDROME_USER: 'listener',
    NAVIDROME_PASSWORD: 'secret',
  } as never);

  it('matches the configured host and the navidrome: protocol', () => {
    expect(api.matchesUrl(new URL('https://music.example:4533/app/#/album/abc'))).toBe(true);
    expect(api.matchesUrl(new URL('navidrome://song/abc'))).toBe(true);
    expect(api.matchesUrl(new URL('https://radio.example/live.m3u8'))).toBe(false);
  });

  it.each([
    ['navidrome://song/song-id', {type: 'song', id: 'song-id'}],
    ['navidrome://album/album-id', {type: 'album', id: 'album-id'}],
    ['navidrome://playlist/playlist-id', {type: 'playlist', id: 'playlist-id'}],
    ['https://music.example:4533/app/#/album/album-id', {type: 'album', id: 'album-id'}],
    ['https://music.example:4533/app/#/playlist/playlist-id', {type: 'playlist', id: 'playlist-id'}],
    ['https://music.example:4533/app/#/song/song-id', {type: 'song', id: 'song-id'}],
  ])('parses %s', (input, expected) => {
    expect(api.parseResource(input)).toEqual(expected);
  });

  it('builds a Subsonic stream URL for play-time resolution', () => {
    const streamUrl = new URL(api.getStreamUrl('song-id'));

    expect(streamUrl.origin + streamUrl.pathname).toBe('https://music.example:4533/rest/stream.view');
    expect(streamUrl.searchParams.get('id')).toBe('song-id');
    expect(streamUrl.searchParams.get('u')).toBe('listener');
    expect(streamUrl.searchParams.get('c')).toBe('muse');
    expect(streamUrl.searchParams.get('f')).toBe('json');
    expect(streamUrl.searchParams.get('t')).toBeTruthy();
    expect(streamUrl.searchParams.get('s')).toBeTruthy();
  });
});

describe('SpotifyAPI album pagination', () => {
  it('collects every album page before applying the configured sample limit', async () => {
    const firstTrack = {name: 'First', artists: [{name: 'First artist'}]};
    const secondTrack = {name: 'Second', artists: [{name: 'Second artist'}]};
    const spotify = {
      getAlbum: vi.fn().mockResolvedValue({
        body: {name: 'Album', href: 'https://open.spotify.com/album/album-id'},
      }),
      getAlbumTracks: vi.fn()
        .mockResolvedValueOnce({
          body: {
            items: [firstTrack],
            next: 'https://api.spotify.com/v1/albums/album-id/tracks?offset=1&limit=1',
          },
        })
        .mockResolvedValueOnce({
          body: {items: [secondTrack], next: null},
        }),
    };
    dependencyMocks.shuffle.mockImplementation((tracks: unknown[]) => [...tracks].reverse());
    const spotifyAPI = new SpotifyAPI({spotify} as never);

    await expect(spotifyAPI.getAlbum('spotify:album:album-id', 1)).resolves.toEqual([
      [{name: 'Second', artist: 'Second artist'}],
      {title: 'Album', source: 'https://open.spotify.com/album/album-id'},
    ]);
    expect(spotify.getAlbumTracks).toHaveBeenNthCalledWith(1, 'album-id', {limit: 50});
    expect(spotify.getAlbumTracks).toHaveBeenNthCalledWith(2, 'album-id', {limit: 1, offset: 1});
    expect(dependencyMocks.shuffle).toHaveBeenCalledWith([firstTrack, secondTrack]);
  });
});
