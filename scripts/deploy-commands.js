const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { validateEnv } = require('../lib/env');
const { REST, Routes } = require('@discordjs/rest');
const { Client, GatewayIntentBits, Events } = require('discord.js');
const fs = require('fs');

validateEnv();

const COMMANDS_FOLDER_PATH = path.join(__dirname, '..', 'commands');
const commandFiles = fs.readdirSync(COMMANDS_FOLDER_PATH).filter((file) => file.endsWith('.js'));
const commands = [];

for (const file of commandFiles) {
    const command = require(path.join(COMMANDS_FOLDER_PATH, file));
    if ('data' in command && 'execute' in command) {
        commands.push(command.data.toJSON());
    }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
    try {
        const rest = new REST().setToken(process.env.DISCORD_TOKEN);
        console.log(`Registering ${commands.length} application command(s)...`);
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('Successfully registered application commands.');
    } catch (error) {
        console.error('Failed to register commands:', error);
        process.exitCode = 1;
    } finally {
        client.destroy();
        process.exit(process.exitCode ?? 0);
    }
});

client.login(process.env.DISCORD_TOKEN);
