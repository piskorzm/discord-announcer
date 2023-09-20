
const { SlashCommandBuilder } = require('discord.js');
const fs = require('fs');

const VOLUME_OPTION = 'volume';
const MIN_VOLUME = 0.01;
const MAX_VOLUME = 5.0;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('set-volume')
        .setDescription('Sets volume of your welcome sound!')
        .addNumberOption(option => option.setName(VOLUME_OPTION).setDescription(`Volume setting between ${MIN_VOLUME} and ${MAX_VOLUME}`).setRequired(true)),
    async execute(interaction) {
        const volume = interaction.options.get(VOLUME_OPTION).value;

        // Validate volume value
        if (!volume || volume < MIN_VOLUME || volume > MAX_VOLUME) {
            interaction.reply(`Please provide a number between ${MIN_VOLUME} and ${MAX_VOLUME}`);
            return;
        }

        // Update the userSettings map
        const newUserSettings = !!interaction.userSettingsMap[interaction.user.tag] ?
            interaction.userSettingsMap[interaction.user.tag] : {};
        newUserSettings.volume = volume;
        interaction.userSettingsMap[interaction.user.tag] = newUserSettings;

        // Save user settings to a JSON file
        fs.writeFileSync(interaction.userSettingsFilePath, JSON.stringify(interaction.userSettingsMap));
        console.log(`Settings updated for user: ${interaction.user.tag}`);
        console.log(newUserSettings);
        
        interaction.reply('Your welcome sound volume has been set to ' + volume);
    },
};