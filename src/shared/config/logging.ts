import type { LogContext } from "../models/logging.ts";

export const noLog: LogContext = {
  event() {},
  operation() {
    return noLog;
  },
};
