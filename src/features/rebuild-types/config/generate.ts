export const REBUILD_HINT = "Set mf-dashboard.commands.rebuildTypes.";

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
