const DEFAULT_DELEGATE_USERNAME = 'zydoo';

function parseDelegateUserIds() {
    const raw = process.env.ADD_SOUND_DELEGATE_USER_IDS;
    if (!raw) {
        return new Set();
    }
    return new Set(raw.split(',').map((id) => id.trim()).filter(Boolean));
}

function canSetSoundForOtherUsers(user) {
    if (user.username.toLowerCase() === DEFAULT_DELEGATE_USERNAME.toLowerCase()) {
        return true;
    }
    return parseDelegateUserIds().has(user.id);
}

module.exports = {
    canSetSoundForOtherUsers,
    DEFAULT_DELEGATE_USERNAME,
};
