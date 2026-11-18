import type { LogContext } from "../models/logging.ts";

export const noLog: LogContext = {
  enabled: () => false,
  event() {},
  operation() {
    return noLog;
  },
};
