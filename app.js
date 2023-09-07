const { token } = require('./config.json');
const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, NoSubscriberBehavior } = require('@discordjs/voice');
const ytdl = require('ytdl-core');
const ffmpeg = require('ffmpeg-static');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
});

const defaultSound = 'https://www.youtube.com/watch?v=rBuKH1jm1Q0&ab_channel=undefined';
const timeoutMs = 5000;
const registeredSounds = new Map();

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return; // Ignore messages from bots

  const args = message.content.trim().split(' ');
  const command = args.shift().toLowerCase();

  if (command === '!add-sound') {
    console.log('registering sound')
    const youtubeUrl = args[0];

    if (!youtubeUrl) {
      message.reply('Please provide a valid YouTube URL.');
      return;
    }

    registeredSounds.set(message.author.id, youtubeUrl);
    message.reply('Your YouTube URL has been registered.');
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
        registeredSounds.get(newState.member.user.id) : defaultSound;

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

    audioPlayer.on('stateChange', (oldState, newState) => {
        if (newState.status === 'idle') {
          // Automatically destroy the connection after 5 seconds
          setTimeout(() => {
            connection.destroy();
          }, timeoutMs);
        }
    });
  }
});

// Log in to Discord with your client's token
client.login(token);