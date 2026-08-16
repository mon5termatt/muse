import {AutocompleteInteraction, ChatInputCommandInteraction} from 'discord.js';
import {URL} from 'url';
import {SlashCommandBuilder, SlashCommandSubcommandsOnlyBuilder} from '@discordjs/builders';
import {inject, injectable, optional} from 'inversify';
import Spotify from 'spotify-web-api-node';
import Command from './index.js';
import {TYPES} from '../types.js';
import ThirdParty from '../services/third-party.js';
import getYouTubeAndSpotifySuggestionsFor, {SpotifySuggestionsUnavailableError} from '../utils/get-youtube-and-spotify-suggestions-for.js';
import KeyValueCacheProvider from '../services/key-value-cache.js';
import {ONE_HOUR_IN_SECONDS} from '../utils/constants.js';
import AddQueryToQueue from '../services/add-query-to-queue.js';
import NavidromeAPI from '../services/navidrome-api.js';
import {PlaySource} from '../services/get-songs.js';

@injectable()
export default class implements Command {
  public readonly slashCommand: Partial<SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder> & Pick<SlashCommandBuilder, 'toJSON'>;

  public requiresVC = true;

  private readonly spotify?: Spotify;
  private readonly cache: KeyValueCacheProvider;
  private readonly addQueryToQueue: AddQueryToQueue;
  private readonly navidromeAPI?: NavidromeAPI;

  constructor(
    @inject(TYPES.ThirdParty) @optional() thirdParty: ThirdParty,
    @inject(TYPES.KeyValueCache) cache: KeyValueCacheProvider,
    @inject(TYPES.Services.AddQueryToQueue) addQueryToQueue: AddQueryToQueue,
    @inject(TYPES.Services.NavidromeAPI) @optional() navidromeAPI?: NavidromeAPI,
  ) {
    this.spotify = thirdParty?.spotify;
    this.cache = cache;
    this.addQueryToQueue = addQueryToQueue;
    this.navidromeAPI = navidromeAPI;

    const queryDescription = this.buildQueryDescription(thirdParty !== undefined, navidromeAPI !== undefined);

    const slashCommand = new SlashCommandBuilder()
      .setName('play')
      .setDescription('play a song')
      .addStringOption(option => option
        .setName('query')
        .setDescription(queryDescription)
        .setAutocomplete(true)
        .setRequired(true));

    if (navidromeAPI !== undefined) {
      slashCommand.addStringOption(option => option
        .setName('source')
        .setDescription('omit to try the library first; force YouTube or library')
        .addChoices(
          {name: 'YouTube', value: 'youtube'},
          {name: 'Library (Navidrome)', value: 'library'},
        ));
    }

    this.slashCommand = slashCommand
      .addBooleanOption(option => option
        .setName('immediate')
        .setDescription('add track to the front of the queue'))
      .addBooleanOption(option => option
        .setName('shuffle')
        .setDescription('shuffle the input if you\'re adding multiple tracks'))
      .addBooleanOption(option => option
        .setName('split')
        .setDescription('if a track has chapters, split it'))
      .addBooleanOption(option => option
        .setName('skip')
        .setDescription('skip the currently playing track'));
  }

  public async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const query = interaction.options.getString('query')!;
    const source = (interaction.options.getString('source') ?? 'auto') as PlaySource;

    await this.addQueryToQueue.addToQueue({
      interaction,
      query: query.trim(),
      addToFrontOfQueue: interaction.options.getBoolean('immediate') ?? false,
      shuffleAdditions: interaction.options.getBoolean('shuffle') ?? false,
      shouldSplitChapters: interaction.options.getBoolean('split') ?? false,
      skipCurrentTrack: interaction.options.getBoolean('skip') ?? false,
      source,
    });
  }

  public async handleAutocompleteInteraction(interaction: AutocompleteInteraction): Promise<void> {
    const query = interaction.options.getString('query')?.trim();

    if (!query || query.length === 0) {
      await interaction.respond([]);
      return;
    }

    let queryProtocol: string | undefined;
    try {
      queryProtocol = new URL(query).protocol;
    } catch {}

    // Don't return suggestions for supported provider URLs
    if (queryProtocol && ['http:', 'https:', 'spotify:', 'navidrome:'].includes(queryProtocol)) {
      await interaction.respond([]);
      return;
    }

    if (interaction.options.getString('source') === 'library') {
      const {navidromeAPI} = this;
      if (navidromeAPI === undefined) {
        await interaction.respond([]);
        return;
      }

      const suggestions = await this.cache.wrap(
        async () => navidromeAPI.suggest(query, 10),
        {
          expiresIn: ONE_HOUR_IN_SECONDS,
          key: `autocomplete:library:${query}`,
        },
      );

      await interaction.respond(suggestions);
      return;
    }

    let suggestions;

    try {
      suggestions = await this.cache.wrap(
        getYouTubeAndSpotifySuggestionsFor,
        query,
        this.spotify,
        10,
        {
          expiresIn: ONE_HOUR_IN_SECONDS,
          key: `autocomplete:${query}`,
        });
    } catch (error: unknown) {
      if (error instanceof SpotifySuggestionsUnavailableError) {
        suggestions = error.suggestions;
      } else {
        throw error;
      }
    }

    const {navidromeAPI} = this;
    if (navidromeAPI !== undefined && interaction.options.getString('source') !== 'youtube') {
      const librarySuggestions = await this.cache.wrap(
        async () => navidromeAPI.suggest(query, 6),
        {
          expiresIn: ONE_HOUR_IN_SECONDS,
          key: `autocomplete:library:${query}`,
        },
      );
      const remaining = Math.max(0, 10 - librarySuggestions.length);
      suggestions = [...librarySuggestions, ...suggestions.slice(0, remaining)];
    }

    await interaction.respond(suggestions);
  }

  private buildQueryDescription(spotifyEnabled: boolean, navidromeEnabled: boolean): string {
    const sources = ['YouTube URL'];

    if (spotifyEnabled) {
      sources.push('Spotify URL');
    }

    if (navidromeEnabled) {
      sources.push('Navidrome URL');
    }

    if (sources.length === 1) {
      return `${sources[0]} or search query`;
    }

    return `${sources.join(', ')}, or search query`;
  }
}
