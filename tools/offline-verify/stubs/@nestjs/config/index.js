exports.ConfigService = class ConfigService { get(){} getOrThrow(){ return {}; } };
exports.ConfigModule = { forRoot: () => ({}) };
exports.registerAs = (k, fn) => Object.assign(fn, { KEY: k });
