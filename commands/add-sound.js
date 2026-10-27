
const { SlashCommandBuilder } = require('discord.js');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const { downloadYoutubeAudio, sanitizeYtDlpError } = require('../lib/ytdlp-client');
const {
    canSetSoundForOtherUsers,
    DEFAULT_DELEGATE_USERNAME,
} = require('../lib/add-sound-delegate');

const MAX_CLIP_DURATION_S = 20;
const YOUTUBE_URL_OPTION = 'youtube-url';
const START_TIME_OPTION = 'start-time';
const END_TIME_OPTION = 'end-time';
const FOR_USER_OPTION = 'for-user';

// Helper function to reply to interaction, handling already-replied cases
async function safeReply(interaction, content) {
    try {
        if (interaction.replied || interaction.deferred) {
            return await interaction.editReply(content);
        } else {
            return await interaction.reply(content);
        }
    } catch (error) {
        try {
            return await interaction.followUp(content);
        } catch (followUpError) {
            console.error('Failed to reply to interaction:', error, followUpError);
        }
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('add-sound')
        .setDescription('Adds your welcome sound to the server! Max duration: ' + MAX_CLIP_DURATION_S + 's')
        .addStringOption(option => option.setName(YOUTUBE_URL_OPTION).setDescription('Youtube video source for your sound').setRequired(true))
        .addStringOption(option => option.setName(START_TIME_OPTION).setDescription('Start point (optional). Format: mm:ss.mmm'))
        .addStringOption(option => option.setName(END_TIME_OPTION).setDescription('End point (optional). Format: mm:ss.mmm'))
        .addUserOption(option =>
            option
                .setName(FOR_USER_OPTION)
                .setDescription(
                    `Register the sound for another member (only @${DEFAULT_DELEGATE_USERNAME} may use this)`
                )
                .setRequired(false)),
    async execute(interaction) {
        console.log("interaction.options");
        console.log(interaction.options.get(YOUTUBE_URL_OPTION));
        const youtubeUrl = interaction.options.get(YOUTUBE_URL_OPTION).value;
        const requestedForUser = interaction.options.getUser(FOR_USER_OPTION);
        const startTime = !!interaction.options.get(START_TIME_OPTION)
            ? parseTimeToSeconds(interaction.options.get(START_TIME_OPTION).value)
            : 0;
        const duration = !!interaction.options.get(END_TIME_OPTION)
            ? parseTimeToSeconds(interaction.options.get(END_TIME_OPTION).value) - startTime
            : MAX_CLIP_DURATION_S;

        if (!youtubeUrl || (!youtubeUrl.includes('youtube.com') && !youtubeUrl.includes('youtu.be'))) {
            await interaction.reply('Please provide a valid YouTube URL.');
            return;
        }

        if (!!duration && duration < 0) {
            await interaction.reply('End time can not be before start time.');
            return;
        }

        let soundOwner = interaction.user;
        if (requestedForUser && requestedForUser.id !== interaction.user.id) {
            if (!canSetSoundForOtherUsers(interaction.user)) {
                await interaction.reply({
                    content:
                        `You cannot set a welcome sound for someone else. Only **${DEFAULT_DELEGATE_USERNAME}** may use the \`${FOR_USER_OPTION}\` option. Your sound will be saved for **you**.`,
                    ephemeral: true,
                });
                await interaction.followUp('Downloading audio clip...');
            } else {
                soundOwner = requestedForUser;
                await interaction.reply(
                    `Downloading audio clip for **${soundOwner.tag}**...`
                );
            }
        } else if (requestedForUser) {
            soundOwner = requestedForUser;
            await interaction.reply('Downloading audio clip...');
        } else {
            await interaction.reply('Downloading audio clip...');
        }

        const ownerTag = soundOwner.tag;

        // Fetch video info to further verify if the video exists
        try {
            const fullAudioPath = `${interaction.audioClipsPath}/full_${ownerTag}.mp4`;
            const trimmedAudioFilePath = `${interaction.audioClipsPath}/${ownerTag}.mp4`;

            try {
                await downloadYoutubeAudio(youtubeUrl, fullAudioPath, (percent) => {
                    process.stdout.clearLine();
                    process.stdout.cursorTo(0);
                    process.stdout.write(`Downloading... ${percent.toFixed(2)}%`);
                });

                // Download completed, now trim with FFmpeg
                // Create an FFmpeg command
                const command = ffmpeg();

                command.input(fullAudioPath);
                command.output(trimmedAudioFilePath);

                command.setStartTime(startTime);
                command.setDuration(duration);

                // Run the FFmpeg command
                command.on('end', () => {
                    console.log(
                        `Trimming complete! Sound registered for user: ${ownerTag}, url: ${youtubeUrl}`
                    );
                    const successMessage =
                        soundOwner.id === interaction.user.id
                            ? 'Your welcome sound has been registered!'
                            : `Welcome sound registered for **${ownerTag}**.`;
                    interaction.followUp(successMessage);

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
                        interaction.followUp('An error occurred while trimming.');
                        console.error('Error:', error);
                    })
                    .run();
            } catch (downloadError) {
                const errorMsg = sanitizeYtDlpError(
                    downloadError.message || String(downloadError)
                );
                await safeReply(interaction, `Error downloading audio clip: ${errorMsg}`);
                console.error('Error downloading:', downloadError);
            }

        } catch (error) {
            // Clean up temporary files even on error
            await safeReply(interaction, 'An error occurred while registering audio clip.');
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