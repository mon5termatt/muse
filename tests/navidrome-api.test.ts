import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => {
  const json = vi.fn();
  const request = vi.fn(() => ({json}));
  return {json, request};
});

vi.mock('got', () => ({
  default: {
    extend: vi.fn(() => mocks.request),
  },
}));

import NavidromeAPI from '../src/services/navidrome-api.js';
import {MediaSource} from '../src/services/player-types.js';

const makeApi = () => new NavidromeAPI({
  NAVIDROME_URL: 'https://music.example:4533',
  NAVIDROME_USER: 'listener',
  NAVIDROME_PASSWORD: 'secret',
} as never);

const subsonic = (payload: Record<string, unknown>) => ({
  'subsonic-response': {
    status: 'ok',
    ...payload,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.json.mockReset();
});

describe('NavidromeAPI library search', () => {
  it('plays every track from an album whose name matches the query', async () => {
    mocks.json
      .mockResolvedValueOnce(subsonic({
        searchResult3: {
          album: [{id: 'album-1', name: 'Escapism Vol. 1', artist: 'Various'}],
          song: [{id: 'track-1', title: 'Intro', album: 'Escapism Vol. 1', albumId: 'album-1'}],
        },
      }))
      .mockResolvedValueOnce(subsonic({
        album: {
          id: 'album-1',
          name: 'Escapism Vol. 1',
          song: [
            {id: 'track-1', title: 'Intro', artist: 'A', duration: 12},
            {id: 'track-2', title: 'Outro', artist: 'B', duration: 34},
          ],
        },
      }));

    const songs = await makeApi().search('Escapism Vol. 1', 50);

    expect(songs).toHaveLength(2);
    expect(songs.map(song => song.title)).toEqual(['Intro', 'Outro']);
    expect(songs[0]).toMatchObject({
      playlist: {title: 'Escapism Vol. 1', source: 'navidrome://album/album-1'},
      source: MediaSource.Navidrome,
    });
    expect(mocks.request).toHaveBeenNthCalledWith(1, 'search3.view', expect.objectContaining({
      searchParams: expect.objectContaining({
        query: 'Escapism Vol. 1',
        albumCount: '10',
        artistCount: '10',
        songCount: '10',
      }),
    }));
    expect(mocks.request).toHaveBeenNthCalledWith(2, 'getAlbum.view', expect.objectContaining({
      searchParams: expect.objectContaining({id: 'album-1'}),
    }));
  });

  it('expands an album when search only returns songs from that album', async () => {
    mocks.json
      .mockResolvedValueOnce(subsonic({
        searchResult3: {
          album: [],
          song: [{
            id: 'track-1',
            title: 'Intro',
            album: 'Escapism Vol. 1',
            albumId: 'album-1',
          }],
        },
      }))
      .mockResolvedValueOnce(subsonic({
        album: {
          id: 'album-1',
          name: 'Escapism Vol. 1',
          song: [
            {id: 'track-1', title: 'Intro', duration: 12},
            {id: 'track-2', title: 'Outro', duration: 34},
          ],
        },
      }));

    const songs = await makeApi().search('escapism vol. 1', 50);

    expect(songs.map(song => song.url)).toEqual(['track-1', 'track-2']);
  });

  it('falls back to the first song when nothing looks like an album match', async () => {
    mocks.json.mockResolvedValueOnce(subsonic({
      searchResult3: {
        album: [{id: 'other-album', name: 'Something Else'}],
        song: [{id: 'song-1', title: 'Neon Lights', artist: 'Artist', duration: 180}],
      },
    }));

    await expect(makeApi().search('Neon Lights', 20)).resolves.toEqual([
      expect.objectContaining({
        title: 'Neon Lights',
        url: 'song-1',
        source: MediaSource.Navidrome,
        playlist: null,
      }),
    ]);
    expect(mocks.request).toHaveBeenCalledOnce();
  });

  it('lists artists, albums, then songs in autocomplete', async () => {
    mocks.json.mockResolvedValueOnce(subsonic({
      searchResult3: {
        artist: [{id: 'artist-1', name: 'Daft Punk'}],
        album: [{id: 'album-1', name: 'Escapism Vol. 1', artist: 'Various'}],
        song: [{id: 'song-1', title: 'Intro', artist: 'A'}],
      },
    }));

    await expect(makeApi().suggest('Escapism', 10)).resolves.toEqual([
      {
        name: 'Library: 🎤 Daft Punk',
        value: 'navidrome://artist/artist-1',
      },
      {
        name: 'Library: 💿 Escapism Vol. 1 - Various',
        value: 'navidrome://album/album-1',
      },
      {
        name: 'Library: 🎵 A - Intro',
        value: 'navidrome://song/song-1',
      },
    ]);
  });

  it('plays an artist discography in album order', async () => {
    mocks.json
      .mockResolvedValueOnce(subsonic({
        searchResult3: {
          artist: [{id: 'artist-1', name: 'Daft Punk'}],
          album: [],
          song: [],
        },
      }))
      .mockResolvedValueOnce(subsonic({
        artist: {
          id: 'artist-1',
          name: 'Daft Punk',
          album: [
            {id: 'album-1', name: 'Homework'},
            {id: 'album-2', name: 'Discovery'},
          ],
        },
      }))
      .mockResolvedValueOnce(subsonic({
        album: {
          id: 'album-1',
          name: 'Homework',
          song: [{id: 'hw-1', title: 'Around the World', artist: 'Daft Punk', duration: 60}],
        },
      }))
      .mockResolvedValueOnce(subsonic({
        album: {
          id: 'album-2',
          name: 'Discovery',
          song: [{id: 'ds-1', title: 'One More Time', artist: 'Daft Punk', duration: 80}],
        },
      }));

    const songs = await makeApi().search('Daft Punk', 50);

    expect(songs.map(song => song.title)).toEqual(['Around the World', 'One More Time']);
    expect(songs[0]?.playlist).toEqual({
      title: 'Daft Punk',
      source: 'navidrome://artist/artist-1',
    });
    expect(mocks.request).toHaveBeenNthCalledWith(2, 'getArtist.view', expect.objectContaining({
      searchParams: expect.objectContaining({id: 'artist-1'}),
    }));
  });
});
