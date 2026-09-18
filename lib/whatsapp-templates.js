export function whatsappTemplateComponent(components = [], type) {
  return components.find(
    (item) => String(item?.type || "").toUpperCase() === String(type).toUpperCase()
  );
}

export function whatsappTemplateVariableIndexes(text) {
  return [...String(text || "").matchAll(/\{\{(\d+)\}\}/g)]
    .map((match) => Number(match[1]))
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort((a, b) => a - b);
}

export function getWhatsAppTemplateVariableFields(template) {
  if (String(template?.category || "").toUpperCase() === "AUTHENTICATION") {
    return [
      {
        key: "body:1",
        label: "OTP code",
        type: "body",
        parameterIndex: 1,
        defaultValue: "",
        copyCodeButtonIndex: 0,
      },
    ];
  }

  const fields = [];
  for (const item of template?.components || []) {
    const type = String(item.type || "").toUpperCase();
    if (["HEADER", "BODY"].includes(type)) {
      const examples =
        type === "BODY"
          ? item.example?.body_text?.[0] || []
          : item.example?.header_text || [];
      whatsappTemplateVariableIndexes(item.text).forEach((parameterIndex) => {
        fields.push({
          key: `${type.toLowerCase()}:${parameterIndex}`,
          label: `${type === "BODY" ? "Body" : "Header"} {{${parameterIndex}}}`,
          type: type.toLowerCase(),
          parameterIndex,
          defaultValue: examples[parameterIndex - 1] || "",
        });
      });
    }
    if (type === "BUTTONS") {
      (item.buttons || []).forEach((button, buttonIndex) => {
        if (!String(button.url || "").includes("{{")) return;
        fields.push({
          key: `button:${buttonIndex}`,
          label: `${button.text || `Button ${buttonIndex + 1}`} URL value`,
          type: "button",
          subType: "url",
          buttonIndex,
          defaultValue: button.example?.[0] || "",
        });
      });
    }
  }
  return fields;
}
