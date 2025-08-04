
const { SlashCommandBuilder } = require('discord.js');
const ffmpeg = require('fluent-ffmpeg');
const ytdl = require('@distube/ytdl-core');
const fs = require('fs');

const MAX_CLIP_DURATION_S = 20;
const YOUTUBE_URL_OPTION = 'youtube-url';
const START_TIME_OPTION = 'start-time';
const END_TIME_OPTION = 'end-time';

module.exports = {
    data: new SlashCommandBuilder()
        .setName('add-sound')
        .setDescription('Adds your welcome sound to the server! Max duration: ' + MAX_CLIP_DURATION_S + 's')
        .addStringOption(option => option.setName(YOUTUBE_URL_OPTION).setDescription('Youtube video source for your sound').setRequired(true))
        .addStringOption(option => option.setName(START_TIME_OPTION).setDescription('Start point (optional). Format: mm:ss.mmm'))
        .addStringOption(option => option.setName(END_TIME_OPTION).setDescription('End point (optional). Format: mm:ss.mmm')),
    async execute(interaction) {
        console.log("interaction.options");
        console.log(interaction.options.get(YOUTUBE_URL_OPTION));
        const youtubeUrl = interaction.options.get(YOUTUBE_URL_OPTION).value;
        const startTime = !!interaction.options.get(START_TIME_OPTION) ? 
            parseTimeToSeconds(interaction.options.get(START_TIME_OPTION).value) : 0;
        const duration = !!interaction.options.get(END_TIME_OPTION) ? 
            parseTimeToSeconds(interaction.options.get(END_TIME_OPTION).value) - startTime : MAX_CLIP_DURATION_S;

        // Validate URL argument syntax
        if (!youtubeUrl || !ytdl.validateURL(youtubeUrl)) {
            await interaction.reply('Please provide a valid YouTube URL.');
            return;
        }

        if (!!duration && duration < 0) {
            await interaction.reply('End time can not be before start time.');
            return;
        }

        // Fetch video info to further verify if the video exists
        try {

            await interaction.reply('Downloading audio clip...');

            const videoInfo = await ytdl.getInfo(youtubeUrl);
            if (!videoInfo) {
                await interaction.reply('The provided YouTube URL does not exist or cannot be accessed.');
                return;
            }

            // Download the video using ytdl-core
            const fullAudioPath = `${interaction.audioClipsPath}/full_${interaction.user.tag}.mp4`;

            const trimmedAudioFilePath = `${interaction.audioClipsPath}/${interaction.user.tag}.mp4`;

            const audioFile = ytdl(youtubeUrl, { filter: 'audioonly' });

            audioFile.pipe(fs.createWriteStream(fullAudioPath));

            audioFile.on('progress', (chunkLength, downloaded, total) => {
                const percent = downloaded / total * 100;
                process.stdout.clearLine();
                process.stdout.cursorTo(0);
                process.stdout.write(`Downloading... ${percent.toFixed(2)}%`);
            });

            audioFile.on('finish', () => {
                // Create an FFmpeg command
                const command = ffmpeg();

                command.input(fullAudioPath);
                command.output(trimmedAudioFilePath);

                command.setStartTime(startTime);
                command.setDuration(duration)

                // Run the FFmpeg command
                command.on('end', () => {
                    console.log(`Trimming complete! Sound registered for user: ${interaction.user.tag}, url: ${youtubeUrl}`);
                    interaction.followUp('Your welcome sound has been registered!');

                    // Remove the full audio
                    fs.unlink(fullAudioPath, (error) => {
                        if (error) {
                            console.error('Error while deleting the file:', error);
                        } else {
                            console.log('File deleted successfully.');
                        }
                    });
                })
                    .on('error', (error) => {
                        interaction.followUp('An error occurred while trimming .');
                        console.error('Error:' + error);
                    })
                    .run();
            });

            audioFile.on('error', (err) => {
                interaction.followUp('An error occurred while downloading audio clip.');
                console.error('Error during download:', err);
            })

        } catch (error) {
            await interaction.reply('An error occurred while registering audio clip.');
            console.error(error);
        }
    },
};

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