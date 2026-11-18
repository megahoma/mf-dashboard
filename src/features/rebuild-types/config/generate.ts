export const REBUILD_HINT = "Set mf-dashboard.commands.rebuildTypes.";

export const MAX_STATIC_DTS_VALUES = 50_000;
export const MAX_STATIC_DTS_TEXT_LENGTH = 1024 * 1024;
export const MAX_STATIC_DTS_DEPTH = 64;

export const cliDefaults = {
  defaultGenerateOptions: {
    generateAPITypes: true,
    compileInChildProcess: false,
    abortOnError: true,
    extractThirdParty: false,
    extractRemoteTypes: false,
  },
  defaultConsumeOptions: {
    abortOnError: true,
    consumeAPITypes: true,
  },
};
