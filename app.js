const { token } = require('./config.json');
const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, NoSubscriberBehavior } = require('@discordjs/voice');
const ytdl = require('ytdl-core');

const DEFAULT_SOUND = 'https://www.youtube.com/watch?v=10LsX1o9An0&ab_channel=Flank3RR';
const TIMEOUT_MS = 7000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
});
const registeredSounds = new Map();

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return; // Ignore messages from bots

  const args = message.content.trim().split(' ');
  const command = args.shift().toLowerCase();

  if (command === '!add-sound') {
    const youtubeUrl = args.length >= 1 ? args[0] : undefined;

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
      }ł

      registeredSounds.set(message.author.id, youtubeUrl);
      console.log(`Sound registered for user: (id: ${message.author.id}, tag: ${message.author.tag}), url: ${youtubeUrl}`);
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

    let registeredSound = !!registeredSounds.get(newState.member.user.id) ?
        registeredSounds.get(newState.member.user.id) : DEFAULT_SOUND;

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