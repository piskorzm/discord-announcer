const { token } = require('./config.json');
const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, NoSubscriberBehavior } = require('@discordjs/voice');
const ytdl = require('ytdl-core');
const fs = require('fs');

const DEFAULT_SOUND = 'https://www.youtube.com/watch?v=10LsX1o9An0&ab_channel=Flank3RR';
const TIMEOUT_MS = 7000;
const REGISTERED_SOUNDS_FILE_PATH = './registered-sounds.json';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
});

const registeredSounds = (() => {
  try {
    const data = fs.readFileSync(REGISTERED_SOUNDS_FILE_PATH);
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading registered sounds:', error);
    return {};
  }
})();

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) {
    // Ignore bot users
    return;
  }

  const args = message.content.trim().split(' ');
  const command = args.shift().toLowerCase();

  if (command === '!add-sound') {
    const youtubeUrl = args.length >= 1 ? args[0] : undefined;

    // Validate URL argument syntax
    if (!youtubeUrl || !ytdl.validateURL(youtubeUrl)) {
      message.reply('Please provide a valid YouTube URL.');
      return;
    }

    // Fetch video info to further verify if the video exists
    try {
      const videoInfo = await ytdl.getInfo(youtubeUrl);
      if (!videoInfo) {
        message.reply('The provided YouTube URL does not exist or cannot be accessed.');
        return;
      }

      // Update the registeredSounds map
      registeredSounds[message.author.tag] = youtubeUrl;

      // Save the updated data to the JSON file
      fs.writeFileSync(REGISTERED_SOUNDS_FILE_PATH, JSON.stringify(registeredSounds));

      console.log(`Sound registered for user: ${message.author.tag}, url: ${youtubeUrl}`);
      message.reply('Your welcome sound has been registered!');
    } catch (error) {
      console.error(error);
      message.reply('An error occurred while fetching video information.');
    }
  }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  if (!oldState.channel && newState.channel) {
    // User joined a voice channel
    if (newState.member.user.bot) {
      // Ignore bot users
      return;
    }

    let registeredSound = !!registeredSounds[newState.member.user.tag] ?
        registeredSounds[newState.member.user.tag] : DEFAULT_SOUND;

    const connection = joinVoiceChannel({
      channelId: newState.channel.id,
      guildId: newState.guild.id,
      adapterCreator: newState.guild.voiceAdapterCreator,
    });

    const audioPlayer = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause,
      },
    });

    const stream = ytdl(registeredSound, { filter: 'audioonly' });

    const audioResource = createAudioResource(stream, {
      inlineVolume: true,
    });

    audioPlayer.play(audioResource);

    connection.subscribe(audioPlayer);

    // Schedule disconnect if the sound is too long
    setTimeout(() => {
      connection.destroy();
    }, TIMEOUT_MS);

    audioPlayer.on('stateChange', (oldState, newState) => {
        if (newState.status === 'idle') {
          connection.destroy();
        }
    });
  }
});

// Log in to Discord with your client's token
client.login(token);