import { applyAssistCommand, assistFieldAt, fillAssistField } from "../../src/cobrowse/assist-control.js";

const privacy = {
  blockSelectors: [".custom-private"], maskSelectors: [".custom-mask"],
};
window.applyAssistCommand = (command) => applyAssistCommand(command, document.getElementById(command.targetId), privacy);
window.fillAssistAt = (command) => fillAssistField(assistFieldAt(document.getElementById(command.targetId), privacy), command.value, privacy);
