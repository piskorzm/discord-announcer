const { TOKEN } = require('./config.json');
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, NoSubscriberBehavior } = require('@discordjs/voice');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const fs = require('fs');

const COMMANDS_FOLDER_PATH = './commands';
const AUDIO_CLIPS_PATH = './audio-clips';
const DEFAULT_SOUND_PATH = AUDIO_CLIPS_PATH + '/default.mp4';
const USER_SETTINGS_FILE_PATH = 'user-settings.json';
const SOUND_PLAY_DELAY_MS = 800;

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
const connections = new Map();

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
    const guild = newState.guild || oldState.guild;
    const channel = newState.channel || oldState.channel;
    const connectionKey = guild.id + channel.id;

    if (!channel) {
        console.error('Channel not found!');
        return;
    }

    // Check if there are no users left in the channel
    if (channel.members.filter(member => !member.user.bot).size === 0 && !!connections.get(connectionKey)) {
        // Disconnect the bot from the channel
        connections.get(connectionKey).destroy();
        connections.delete(connectionKey);
        console.log(`Bot disconnected from ${channel.name} due to no users.`);
        return;
    }

    if (newState.channel && (!oldState.channelId || oldState.channelId !== newState.channelId)) {
        // User joined a voice channel
        if (newState.member.user.bot) {
            // Ignore bot users
            return;
        }

        const userAudioPath = `${AUDIO_CLIPS_PATH}/${newState.member.user.tag}.mp4`;
        const audioPath = fs.existsSync(userAudioPath) ? userAudioPath : DEFAULT_SOUND_PATH;

        const connection = joinVoiceChannel({
            channelId: newState.channel.id,
            guildId: newState.guild.id,
            adapterCreator: newState.guild.voiceAdapterCreator,
        });

        connections.set(connectionKey, connection);

        const audioPlayer = createAudioPlayer({
            behaviors: {
                noSubscriber: NoSubscriberBehavior.Pause,
            },
        });

        const audioResource = createAudioResource(audioPath, { inlineVolume: true });
        const volume = !!userSettingsMap[newState.member.user.tag] ? userSettingsMap[newState.member.user.tag].volume : 1.0;
        audioResource.volume.setVolume(volume);

        setTimeout(() => {
            connection.subscribe(audioPlayer);
            audioPlayer.play(audioResource);
            console.log(`Playing sound for ${newState.member.user.tag}`);
        }, SOUND_PLAY_DELAY_MS)
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
