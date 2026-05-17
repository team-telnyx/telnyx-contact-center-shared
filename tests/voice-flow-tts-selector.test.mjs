import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const editorPaths = [
  "../components/voice-flow/SpeakNodeEditor.jsx",
  "../components/voice-flow/GatherSpeakNodeEditor.jsx",
];

async function sourceFor(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

function extractFunction(source, name, nextName) {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start > -1, `${name} should exist`);
  const end = source.indexOf(`function ${nextName}`, start);
  assert.ok(end > start, `${name} should end before ${nextName}`);
  return source.slice(start, end);
}

function loadParseVoiceString(source) {
  const fnSource = extractFunction(source, "parseVoiceString", "buildVoiceString");
  return vm.runInNewContext(`${fnSource}; parseVoiceString;`);
}

const providers = [
  {
    id: "Minimax",
    name: "Minimax",
    models: [
      { id: "speech-2.8-turbo", name: "speech-2.8-turbo", voices: [] },
      { id: "speech-2.6", name: "speech-2.6", voices: [] },
    ],
  },
  {
    id: "AWS",
    name: "AWS",
    models: [{ id: "Polly", name: "Polly", voices: [] }],
  },
];

for (const editorPath of editorPaths) {
  test(`${editorPath} keeps dotted TTS model ids when parsing selected voices`, async () => {
    const source = await sourceFor(editorPath);
    const parseVoiceString = loadParseVoiceString(source);

    assert.deepEqual(
      JSON.parse(JSON.stringify(parseVoiceString("Minimax.speech-2.8-turbo.English_magnetic_voiced_man", providers))),
      {
        provider: "Minimax",
        model: "speech-2.8-turbo",
        voiceName: "Minimax.speech-2.8-turbo.English_magnetic_voiced_man",
      }
    );

    assert.deepEqual(JSON.parse(JSON.stringify(parseVoiceString("AWS.Polly.Joanna", providers))), {
      provider: "AWS",
      model: "Polly",
      voiceName: "AWS.Polly.Joanna",
    });
  });

  test(`${editorPath} reparses saved voices after the provider catalog loads`, async () => {
    const source = await sourceFor(editorPath);

    assert.match(source, /parseVoiceString\(config\.voice \|\| "AWS\.Polly\.Joanna", providers\)/, "parser should use the loaded provider/model catalog");
    assert.match(source, /\[config\.voice, providers\]/, "parse memo should rerun after voices are fetched");
    assert.match(source, /languageOptions\.length > 0 \|\| languageFilter/, "language selector should stay visible when a language is selected");
  });
}
