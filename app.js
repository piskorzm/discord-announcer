const { token } = require('./config.json');
const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, NoSubscriberBehavior } = require('@discordjs/voice');
const ytdl = require('ytdl-core');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');

const AUDIO_CLIPS_PATH = './audio-clips';
const DEFAULT_SOUND = AUDIO_CLIPS_PATH + '/default.mp4';
const MAX_CLIP_DURATION = 7;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
});

const connections = new Map();

// Create the tempVideoFolder if it doesn't exist
if (!fs.existsSync(AUDIO_CLIPS_PATH)) {
  fs.mkdirSync(AUDIO_CLIPS_PATH);
}

function parseTimeToSeconds(timeString) {
  if (!timeString.includes(':')) {
    return Number(timeString);
  }

  const [minutes, seconds] = timeString.split(':').map(Number);

  if (isNaN(minutes) || isNaN(seconds)) {
    return 0;
  }

  return minutes * 60 + seconds;
}

function getNonBotUserCount(channel) {
  return channel.members.filter(member => !member.user.bot).size;
}

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
    const startTime = args.length >= 2 ? parseTimeToSeconds(args[1]) : 0;
    const duration = args.length >= 3 && !!parseTimeToSeconds(args[2]) ? parseTimeToSeconds(args[2]) - startTime : MAX_CLIP_DURATION;

    // Validate URL argument syntax
    if (!youtubeUrl || !ytdl.validateURL(youtubeUrl)) {
      message.reply('Please provide a valid YouTube URL.');
      return;
    }

    if (!!duration && duration < 0) {
      message.reply('End time can not be before start time.');
    }

    // Fetch video info to further verify if the video exists
    try {
      const videoInfo = await ytdl.getInfo(youtubeUrl);
      if (!videoInfo) {
        message.reply('The provided YouTube URL does not exist or cannot be accessed.');
        return;
      }

      // Download the video using ytdl-core
      const fullAudioPath = `${AUDIO_CLIPS_PATH}/full_${message.author.tag}.mp4`; 
      
      const trimmedAudioFilePath = `${AUDIO_CLIPS_PATH}/${message.author.tag}.mp4`;

      message.reply('Downloading audio clip...');
      const audioFile = ytdl(youtubeUrl, { filter: 'audioonly', format: 'mp4'});
      audioFile.pipe(fs.createWriteStream(fullAudioPath));
      audioFile.on('progress', (chunkLength, downloaded, total) => {
        const percent = downloaded / total * 100;
        process.stdout.clearLine();
        process.stdout.cursorTo(0);
        process.stdout.write(`Downloading... ${percent.toFixed(2)}%`);
      });
      audioFile.on('finish', () => {
            
      console.error('finish:');
      // Create an FFmpeg command
      const command = ffmpeg();

      // Set input file
      command.input(fullAudioPath);

      command.setStartTime(startTime);
      command.setDuration(duration)

      // Set output file path
      command.output(trimmedAudioFilePath);

      // Run the FFmpeg command
      command.on('end', () => {
        console.log('Trimming finished');
        console.log(`Sound registered for user: ${message.author.tag}, url: ${youtubeUrl}`);
        message.reply('Your welcome sound has been registered!');

        // Remove the full audio
        fs.unlink(fullAudioPath, (error) => {
          if (error) {
            console.error('Error while deleting the file:', error);
          } else {
            console.log('File deleted successfully.');
          }
        });
      })
      .on('error', (err) => {
        message.reply('An error occurred while trimming .');
        console.error('Error:');
      })
      .run();
    });
    audioFile.on('error', (err) => {
      message.reply('An error occurred while downloading audio clip.');
      console.error('Error during download:', err);
    })
          
    } catch (error) {
      console.error(error);
      message.reply('An error occurred while registering audio clip.');
    }
  }
});

client.on('voiceStateUpdate', async (oldState, newState) => {

  const channelId = newState.channelId || oldState.channelId;
  const channel = client.channels.cache.get(channelId);

  if (!channel) {
    console.error('Channel not found');
    return;
  }

  // Check if there are no users left in the channel
  if (getNonBotUserCount(channel) === 0 && !!connections.get(channelId)) {
    // Disconnect the bot from the channel
    connections.get(channelId).destroy();
    connections.delete(channelId);
    console.log(`Bot disconnected from ${channel.name} due to no users.`);
    return;
  }

  if ((oldState.mute === null || oldState.mute === newState.mute) && (oldState.deaf === null || oldState.deaf === newState.deaf)) {
    // User joined a voice channel
    if (newState.member.user.bot) {
      // Ignore bot users
      return;
    }

    const userAudioPath = `${AUDIO_CLIPS_PATH}/${newState.member.user.tag}.mp4`;
    const audioPath = fs.existsSync(userAudioPath) ? userAudioPath : DEFAULT_SOUND;

    const connection = joinVoiceChannel({
      channelId: newState.channel.id,
      guildId: newState.guild.id,
      adapterCreator: newState.guild.voiceAdapterCreator,
    });

    connections.set(channelId, connection);

    const audioPlayer = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause,
      },
    });
          
    const audioResource = createAudioResource(audioPath);

    audioPlayer.play(audioResource);

    connection.subscribe(audioPlayer);
  }
});

// Log in to Discord with your client's token
client.login(token);
        