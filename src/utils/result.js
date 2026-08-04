import { MAX_COMMAND_OUTPUT } from "../config.js";

export function textResult(text) {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
}

export function limitOutput(value = "") {
  const text = String(value);

  if (text.length <= MAX_COMMAND_OUTPUT) {
    return text;
  }

  return (
    text.slice(0, MAX_COMMAND_OUTPUT) +
    "\n\n[Output da bi rut gon vi vuot gioi han.]"
  );
}
