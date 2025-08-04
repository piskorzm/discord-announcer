const { TOKEN } = require('./config.json');
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, NoSubscriberBehavior, getVoiceConnection } = require('@discordjs/voice');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const fs = require('fs');

const COMMANDS_FOLDER_PATH = './commands';
const AUDIO_CLIPS_PATH = './audio-clips';
const DEFAULT_SOUND_PATH = AUDIO_CLIPS_PATH + '/default.mp4';
const USER_SETTINGS_FILE_PATH = 'user-settings.json';
const SOUND_PLAY_DELAY_MS = 800;
const DEFAULT_VOLUME = 0.1;

// Create the tempVideoFolder if it doesn't exist
if (!fs.existsSync(AUDIO_CLIPS_PATH)) {
    fs.mkdirSync(AUDIO_CLIPS_PATH);
}

// Read user settings from a file
const userSettingsMap = (() => {
    try {
        const data = fs.readFileSync(USER_SETTINGS_FILE_PATH);
        return JSON.parse(data);
    } catch (error) {
        console.error('Error loading registered sounds:', error);
        return {};
    }
})();

const commandFiles = fs.readdirSync(COMMANDS_FOLDER_PATH).filter(file => file.endsWith('.js'));
const commands = [];

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});
client.commands = new Map();

for (const file of commandFiles) {
    const filePath = COMMANDS_FOLDER_PATH + '/' + file;
    const command = require(filePath);
    if ('data' in command && 'execute' in command) {
        client.commands.set(command.data.name, command);
        commands.push(command.data.toJSON());
    } else {
        console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
    }
}

client.once(Events.ClientReady, () => {
    console.log(`Logged in as ${client.user.tag}!`);

    // Register app commands on server
    /*try {
        console.log('Started refreshing application commands.');

        const rest = new REST().setToken(TOKEN);
        rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands },
        ).then(() => {
            console.log('Successfully reloaded application commands.');
        }).catch(console.error);
    } catch (error) {
        console.error(error);
    }*/
});


client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    const user = newState.member;

    // Ignore if user is not found
    if (!user || !user.user) {
        return;
    }

    // Don't play sound for bot users
    if (user.user.bot) {
        // Destroy connection if bot user was moved to an empty channel
        if (newState.channel !== null && onlyBotInChannel(newState.channel)) {
            console.log(`Bot is alone in ${newState.channel.name}, destroying connection`);
            getVoiceConnection(newState.channel.guildId).destroy();
        }
        return;
    }

    // User joined a voice channel
    if (oldState.channel === null && newState.channel !== null) {
        console.log(`${user.user.tag} joined ${newState.channel.name}`);
        playSoundForUser(user, newState.channel);
        return;
    }

    // User left a voice channel
    if (oldState.channel !== null && newState.channel === null) {
        console.log(`${user.user.tag} left ${oldState.channel.name}`);
        // Destroy connection if bot is alone in the channel
        if (onlyBotInChannel(oldState.channel)) {
            console.log(`Bot is alone in ${oldState.channel.name}, destroying connection`);
            getVoiceConnection(oldState.channel.guildId).destroy();
        }
        return;
    }

    // User moved to a different channel
    if (oldState.channel !== null && newState.channel !== null && oldState.channelId !== newState.channelId) {
        console.log(`${user.user.tag} moved from ${oldState.channel.name} to ${newState.channel.name}`);
        playSoundForUser(user, newState.channel);
        return;
    }
});

// Handle commands
client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const command = interaction.client.commands.get(interaction.commandName);

    if (!command) {
        console.error(`No command matching ${interaction.commandName} was found.`);
        return;
    }

    try {
        // Pass extra settings to the command
        interaction.userSettingsMap = userSettingsMap;
        interaction.userSettingsFilePath = USER_SETTINGS_FILE_PATH;
        interaction.audioClipsPath = AUDIO_CLIPS_PATH;

        await command.execute(interaction);
    } catch (error) {
        console.error(error);
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: 'There was an error while executing this command!', ephemeral: true });
        } else {
            await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
        }
    }
});

// Log in to Discord with bot token
client.login(TOKEN);

// Play sound for a user in a voice channel
function playSoundForUser(user, channel) {
    const userTag = user.user.tag;

    var connection = getVoiceConnection(channel.guildId);

    if (connection) {
    console.log(connection.joinConfig.channelId)
    console.log(channel.id)
    }

    if (!connection) {
        connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: channel.guild.id,
            adapterCreator: channel.guild.voiceAdapterCreator,
        });
    } 
    else if (connection.joinConfig.channelId !== channel.id) {
        connection.destroy();
        connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: channel.guild.id,
            adapterCreator: channel.guild.voiceAdapterCreator,
        });
    }

    const audioPlayer = createAudioPlayer({
        behaviors: {
            noSubscriber: NoSubscriberBehavior.Pause,
        },
    });

    const audioResource = createAudioResourceForUser(userTag);

    setTimeout(() => {
        connection.subscribe(audioPlayer);
        audioPlayer.play(audioResource);
        console.log(`Playing sound for ${userTag}`);
    }, SOUND_PLAY_DELAY_MS)
}

// Create an audio resource for a user from the audio clips folder
function createAudioResourceForUser(userTag) {
    const userAudioPath = `${AUDIO_CLIPS_PATH}/${userTag}.mp4`;
    const audioPath = fs.existsSync(userAudioPath) ? userAudioPath : DEFAULT_SOUND_PATH;
    const audioResource = createAudioResource(audioPath, { inlineVolume: true });
    const volume = !!userSettingsMap[userTag] ? userSettingsMap[userTag].volume : DEFAULT_VOLUME;
    audioResource.volume.setVolume(volume);

    return audioResource;
}

// Check if the channel has only bot users
function onlyBotInChannel(channel) {
    return channel.members.filter(member => !member.user.bot).size === 0 && channel.members.filter(member => member.user.bot).size > 0;
}
