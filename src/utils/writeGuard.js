import { WRITE_ENABLED } from "../config.js";

export function assertWriteEnabled() {
  if (!WRITE_ENABLED) {
    throw new Error(
      "Cac tool thay doi workspace hien dang bi tat. " +
        "Dat MCP_WRITE_ENABLED=true roi restart server."
    );
  }
}
