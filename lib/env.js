const REQUIRED_ENV_VARS = ['DISCORD_TOKEN'];

function validateEnv() {
    const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]?.trim());
    if (missing.length === 0) {
        return;
    }
    console.error(`Missing required environment variable(s): ${missing.join(', ')}`);
    console.error('Copy .env.example to .env in the project root and set the required values.');
    process.exit(1);
}

module.exports = {
    validateEnv,
    REQUIRED_ENV_VARS,
};
